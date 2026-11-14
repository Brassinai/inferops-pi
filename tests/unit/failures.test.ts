import { refreshProvider } from "../fixtures/provider.js";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { createInferCloudProvider } from "../../src/provider/infercloud.js";
import { verifiedCatalog } from "../fixtures/catalog.js";

async function infer(response: () => Response | Promise<Response>) {
  let requests = 0;
  const connection = createInferCloudProvider({ env: () => ({ INFERCLOUD_BASE_URL: "https://gateway.invalid/v1", INFERCLOUD_API_KEY: "synthetic-key" }),
    fetch: async (url) => {
      if (String(url).includes("/models?")) return Response.json(verifiedCatalog());
      requests++; return response();
    },
  });
  await refreshProvider(connection.provider);
  const model = connection.provider.getModels()[0]!;
  const result = await connection.provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }), { apiKey: "synthetic-key", maxRetries: 5 }).result();
  connection.dispose();
  return { result, requests };
}

function safe(message: AssistantMessage) {
  assert.ok(!JSON.stringify(message).includes("private-canary"));
  assert.equal(message.diagnostics, undefined);
}

test("gateway failures have actionable messages without private payloads or automatic retries", async () => {
  for (const item of [
    { status: 401, code: "invalid_api_key", pattern: /invalid or revoked/ },
    { status: 403, code: "forbidden", pattern: /project access/ },
    { status: 402, code: "insufficient_balance", pattern: /billing/ },
    { status: 400, code: "invalid_payment", pattern: /billing/ },
    { status: 402, code: "spend_limit_exceeded", pattern: /spending limits/ },
    { status: 429, code: "requests_per_minute_exceeded", pattern: /throttling/ },
    { status: 503, code: "provider_rate_limited", pattern: /throttling/ },
    { status: 503, code: "no_compatible_offering", pattern: /verified route/ },
    { status: 503, code: "capability_verification_unavailable", pattern: /verified route/ },
    { status: 503, code: "provider_auth_failed", pattern: /gateway authorization/ },
    { status: 503, code: "provider_timeout", pattern: /deadline/ },
    { status: 503, code: "provider_unavailable", pattern: /could not serve/ },
    { status: 400, code: "invalid_chat_request", pattern: /text-only/ },
  ]) {
    const { result, requests } = await infer(() => Response.json({ error: { code: item.code, message: "private-canary", metadata: { raw: "private-canary" } } }, { status: item.status }));
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage ?? "", item.pattern);
    safe(result); assert.equal(requests, 1); assert.equal(isRetryableAssistantError(result), false);
    assert.equal(isContextOverflow(result, 8192), false);
  }
});

test("only explicit context-overflow contract enables Pi context recovery", async () => {
  const { result, requests } = await infer(() => Response.json({ error: { code: "context_length_exceeded", message: "private-canary" } }, { status: 400 }));
  assert.equal(isContextOverflow(result, 8192), true); assert.equal(isRetryableAssistantError(result), false);
  assert.equal(requests, 1); safe(result);
  const unknown = await infer(() => new Response("context_length_exceeded private-canary", { status: 400 }));
  assert.equal(isContextOverflow(unknown.result, 8192), false); safe(unknown.result);
});

test("partial streams retain useful content and never replay after malformed or lost completion", async () => {
  const prefix = 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Partial response"},"finish_reason":null}]}\n\n';
  for (const suffix of ["", 'data: {"error":{"message":"private-canary"}}\n\n', 'data: malformed-private-canary\n\n']) {
    const { result, requests } = await infer(() => new Response(prefix + suffix, { headers: { "Content-Type": "text/event-stream" } }));
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /Review any partial output/);
    assert.ok(result.content.some((part) => part.type === "text" && part.text.includes("Partial response")));
    assert.equal(isRetryableAssistantError(result), false); assert.equal(isContextOverflow(result, 8192), false);
    assert.equal(requests, 1); safe(result);
  }
});

test("transport errors cannot expose URLs, headers, or exception bodies", async () => {
  const { result, requests } = await infer(() => { throw new Error("private-canary https://secret.invalid Authorization: private-canary"); });
  assert.equal(result.stopReason, "error"); assert.equal(requests, 1); safe(result);
  assert.equal(isRetryableAssistantError(result), false);
});

test("an established but stalled stream is cancelled at its deadline without replay", { timeout: 5000 }, async (t) => {
  const { createServer } = await import("node:http");
  let requests = 0;
  let notifyClosed: (() => void) | undefined;
  const closed = new Promise<void>((done) => { notifyClosed = done; });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/models?")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(verifiedCatalog())); return; }
    requests++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Partial"},"finish_reason":null}]}\n\n');
    response.once("close", () => { notifyClosed?.(); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const connection = createInferCloudProvider({ env: () => ({ INFERCLOUD_BASE_URL: `http://127.0.0.1:${address.port}/v1`, INFERCLOUD_API_KEY: "synthetic-key" }) });
  await refreshProvider(connection.provider);
  const model = connection.provider.getModels()[0]!;
  const result = await connection.provider.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: "synthetic-key", timeoutMs: 100 }).result();
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage ?? "", /deadline/);
  assert.equal(isRetryableAssistantError(result), false); assert.equal(requests, 1);
  await closed;
  connection.dispose();
});
