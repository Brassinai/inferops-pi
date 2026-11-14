import { refreshProvider } from "../fixtures/provider.js";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createInferCloudProvider } from "../../src/provider/infercloud.js";
import { verifiedCatalog } from "../fixtures/catalog.js";

test("interleaved tool calls survive fragmented UTF-8 and keep cached usage distinct", async () => {
  const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const wire = event({ role: "assistant", tool_calls: [
    { index: 0, id: "call_one", type: "function", function: { name: "read", arguments: '{"path":"caf' } },
    { index: 1, id: "call_two", type: "function", function: { name: "read", arguments: '{"path":"sec' } },
  ] }) + event({ tool_calls: [
    { index: 1, function: { arguments: 'ond.txt"}' } },
    { index: 0, function: { arguments: 'é.txt"}' } },
  ] }) + event({}, "tool_calls") + `data: ${JSON.stringify({ choices: [], usage: {
    prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, prompt_tokens_details: { cached_tokens: 10 },
  } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(wire);
  const connection = createInferCloudProvider({
    env: () => ({ INFERCLOUD_BASE_URL: "https://gateway.invalid/v1", INFERCLOUD_API_KEY: "synthetic-key" }),
    fetch: async (url) => String(url).includes("/models?") ? Response.json(verifiedCatalog()) : new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { headers: { "Content-Type": "text/event-stream" } }),
  });
  try {
    await refreshProvider(connection.provider);
    const result = await connection.provider.streamSimple(connection.provider.getModels()[0]!, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
    assert.equal(result.stopReason, "toolUse");
    const calls = result.content.filter((part) => part.type === "toolCall");
    assert.deepEqual(calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })), [
      { id: "call_one", name: "read", arguments: { path: "café.txt" } },
      { id: "call_two", name: "read", arguments: { path: "second.txt" } },
    ]);
    assert.equal(result.usage.input, 30);
    assert.equal(result.usage.cacheRead, 10);
    assert.equal(result.usage.output, 10);
  } finally { connection.dispose(); }
});
