import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { projectCatalog } from "../fixtures/catalog.js";
import { modelFailureCategory, runCompatibilitySmoke } from "../../scripts/compatibility-smoke.js";
import { installPackedPackage } from "../fixtures/packed-package.js";

interface WireMessage {
  role: string;
  tool_call_id?: string;
}

test("model failure diagnostics classify failures without returning provider content", () => {
  for (const [message, category] of [
    ['400 {"error":{"code":"context_length_exceeded","message":"private-canary"}}', "context limit"],
    ["max_completion_tokens exceeds the output budget: private-canary", "output limit"],
    ["401 private-canary", "authentication"],
    ["429 private-canary", "rate limit"],
    ["503 private-canary", "route unavailable"],
    ["private-canary", "provider or transport error"],
  ]) assert.equal(modelFailureCategory(message), category);
});

function chunk(response: ServerResponse, delta: unknown, finishReason: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk",
    created: 1, model: "synthetic-coder", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function end(response: ServerResponse, finishReason: string) {
  chunk(response, {}, finishReason);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk",
    created: 1, model: "synthetic-coder", choices: [],
    usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

for (const mode of ["manual", "environment", "native", "packed", "recovery"] as const) {
const extension = mode !== "manual" && mode !== "recovery";
test(`${extension ? `InferCloud ${mode} connection in` : "configured"} stock Pi streams text, completes the tool-result loop, and closes an aborted stream`, { timeout: 60_000 }, async (t) => {
  const packed = mode === "packed" ? await installPackedPackage() : undefined;
  if (packed) t.after(packed.cleanup);
  let inferenceRequests = 0;
  let toolResultsReplayed = 0;
  let cancelledConnection = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-smoke-key");
    if (request.url === "/v1/models?include=metadata") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(projectCatalog()));
      return;
    }
    if (request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: "synthetic-coder", object: "model" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const part of request) raw += String(part);
    const payload = JSON.parse(raw) as { model: string; stream: boolean;
      messages: WireMessage[]; tools?: { function: { name: string } }[];
      stream_options: { include_usage: boolean } };
    assert.equal(payload.model, "synthetic-coder");
    assert.equal(payload.stream, true);
    assert.equal((payload as unknown as { temperature: number }).temperature, 0);
    assert.equal(payload.stream_options.include_usage, true);
    if (extension) {
      assert.equal(request.headers["x-infercloud-routing-profile"], "text-coding");
      assert.equal(request.headers["x-infercloud-min-context-tokens"], "8192");
      assert.equal(request.headers["x-infercloud-min-output-tokens"], "512");
      const budget = payload as unknown as { max_tokens?: number; max_completion_tokens?: number };
      assert.equal(budget.max_tokens ?? budget.max_completion_tokens, 512);
    }
    inferenceRequests++;
    response.setHeader("X-Request-ID", `synthetic-request-${inferenceRequests}`);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    chunk(response, { role: "assistant", content: "" });
    if (raw.includes("Count from 1 to 10000")) {
      chunk(response, { content: "1\n" });
      const timer = setInterval(() => chunk(response, { content: "2\n" }), 100);
      response.once("close", () => { clearInterval(timer); cancelledConnection = true; });
      return;
    }
    if (payload.tools?.length) {
      assert.deepEqual(payload.tools.map((tool) => tool.function.name).sort(), ["bash", "edit", "read"]);
      const results = payload.messages.filter((message) => message.role === "tool");
      toolResultsReplayed = Math.max(toolResultsReplayed, results.length);
      assert.ok(results.every((message) => typeof message.tool_call_id === "string"));
      const calls = [
        ...(mode === "recovery" ? [{ name: "read", args: { path: "missing.mjs" } }] : []),
        { name: "read", args: { path: "greeting.mjs" } },
        { name: "edit", args: { path: "greeting.mjs", oldText: "Hello, ", newText: "Hi, " } },
        { name: "bash", args: { command: "node verify.mjs" } },
      ];
      const call = calls[results.length];
      if (call) {
        const args = JSON.stringify(call.args);
        const split = Math.floor(args.length / 2);
        chunk(response, { tool_calls: [{ index: 0, id: `call_smoke_${call.name}_${results.length}`, type: "function",
          function: { name: call.name, arguments: args.slice(0, split) } }] });
        chunk(response, { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] });
        end(response, "tool_calls");
        return;
      }
    }
    chunk(response, { content: "Hello " });
    chunk(response, { content: "from the synthetic fixture." });
    end(response, "stop");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const report = await runCompatibilitySmoke({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-smoke-key",
    model: "synthetic-coder", contextWindow: 8192, maxOutputTokens: 512, timeoutMs: 15_000,
    ...(packed ? { packagePath: packed.packagePath } : extension ? { extensionPath: fileURLToPath(new URL("../../src/index.ts", import.meta.url)) } : {}),
    nativeLogin: mode === "native" || mode === "packed",
  });
  assert.equal(report.piVersion, "1.5.2");
  const requestCount = mode === "recovery" ? 7 : 6;
  assert.equal(report.phases.flatMap((phase) => phase.requests).length, requestCount);
  assert.ok(report.phases.flatMap((phase) => phase.requests).every((record) => record.requestId));
  assert.equal(inferenceRequests, requestCount);
  assert.equal(toolResultsReplayed, mode === "recovery" ? 4 : 3);
  assert.equal(cancelledConnection, true);
  assert.deepEqual(report.phases.map((phase) => phase.phase), ["text", "tools", "cancellation"]);
  assert.deepEqual(report.phases[1]?.tools, { read: 1, edit: 1, bash: 1 });
  assert.equal(report.phases[1]?.toolErrors, mode === "recovery" ? 1 : 0);
  assert.equal(report.phases[1]?.inputTokens, mode === "recovery" ? 200 : 160);
  assert.equal(report.phases[1]?.outputTokens, mode === "recovery" ? 50 : 40);
  assert.equal(report.phases[2]?.aborted, true);
  assert.ok(report.gatewayUsageReconciliation.startsWith("pending:"));
  assert.ok(!JSON.stringify(report).includes("synthetic-smoke-key"));
  assert.ok(!JSON.stringify(report).includes("Hello from the synthetic fixture"));
});

}

test("discovery failures do not expose the provider's response body", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(401);
    response.end("sensitive-provider-error-canary");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(runCompatibilitySmoke({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-invalid-key",
    model: "synthetic-coder", contextWindow: 8192, maxOutputTokens: 512,
  }), { message: "Gateway model discovery returned HTTP 401." });
  assert.equal(requests, 1);
});
