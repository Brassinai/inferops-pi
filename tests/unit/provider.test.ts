import { refreshProvider } from "../fixtures/provider.js";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createInferCloudProvider } from "../../src/provider/infercloud.js";
import { DEFAULT_BASE_URL } from "../../src/auth/config.js";
import { projectCatalog, verifiedCatalog } from "../fixtures/catalog.js";

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return { allowNetwork: true, signal: new AbortController().signal,
    publish: async ({ update }) => { update?.(); return true; }, ...overrides };
}
const environment = () => ({ INFERCLOUD_API_KEY: "synthetic-key", INFERCLOUD_BASE_URL: "https://gateway.invalid/v1" });

test("provider discovers only verified models, handles empty/error catalogs, and never persists them", async () => {
  let payload: unknown = verifiedCatalog();
  let status = 200;
  const connection = createInferCloudProvider({ env: environment, fetch: async () => Response.json(payload, { status }) });
  const context = refreshContext({ publish: async (publication) => {
    assert.equal(publication.persist, undefined); publication.update?.(); return true;
  } });
  await connection.provider.refreshModels?.(context);
  assert.equal(connection.provider.getModels().length, 1);
  assert.equal(connection.provider.getModels()[0]?.api, "openai-completions");
  const copy = connection.provider.getModels()[0]!; copy.headers = {}; copy.maxTokens = 9000;
  assert.equal(connection.provider.getModels()[0]?.maxTokens, 512);
  const previous = connection.provider.getModels()[0]!;
  status = 401;
  await assert.rejects(connection.provider.refreshModels!(context), { code: "unauthorized" });
  assert.deepEqual(connection.provider.getModels(), []);
  const failedRequest = await connection.provider.streamSimple(previous, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
  assert.match(failedRequest.errorMessage ?? "", /invalid or revoked/);
  status = 200; payload = { object: "list", data: [] };
  await connection.provider.refreshModels?.(context);
  assert.deepEqual(connection.provider.getModels(), []);
  const emptyRequest = await connection.provider.streamSimple(previous, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
  assert.match(emptyRequest.errorMessage ?? "", /no verified coding models/);
  connection.dispose();
});

test("expired attestations, aged discovery, changed credentials, and shutdown invalidate the catalog", async () => {
  let now = Date.now();
  let env = environment();
  const payload = verifiedCatalog(now);
  payload.data[0]!.infercloud.verificationExpiresAt = new Date(now + 10_000).toISOString();
  const connection = createInferCloudProvider({ env: () => env, now: () => now, fetch: async () => Response.json(payload) });
  await connection.provider.refreshModels?.(refreshContext());
  assert.equal(connection.provider.getModels().length, 1);
  const old = connection.provider.getModels()[0]!;
  now += 10_001;
  assert.deepEqual(connection.provider.getModels(), []);
  const result = await connection.provider.streamSimple(old, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage ?? "", /stale/);
  payload.data[0]!.infercloud.verificationExpiresAt = new Date(now + 3600_000).toISOString();
  await connection.provider.refreshModels?.(refreshContext());
  now += 60_000; // The documented catalog freshness limit.
  assert.deepEqual(connection.provider.getModels(), []);
  await connection.provider.refreshModels?.(refreshContext());
  env = { ...env, INFERCLOUD_API_KEY: "rotated-key" };
  assert.deepEqual(connection.provider.getModels(), []);
  await connection.provider.refreshModels?.(refreshContext());
  assert.equal(connection.provider.getModels().length, 1);
  assert.deepEqual(connection.provider.filterModels?.(connection.provider.getModels(), { type: "api_key", key: "other-project" }), []);
  connection.dispose();
  assert.deepEqual(connection.provider.getModels(), []);
});

test("Pi publication generation prevents superseded refreshes from resurrecting models", async () => {
  let finishFirst: ((response: Response) => void) | undefined;
  let calls = 0;
  const connection = createInferCloudProvider({ env: environment, fetch: async () => {
    calls++;
    if (calls === 1) return new Promise<Response>((done) => { finishFirst = done; });
    return Response.json({ object: "list", data: [] });
  } });
  const first = connection.provider.refreshModels!(refreshContext());
  await connection.provider.refreshModels?.(refreshContext());
  finishFirst!(Response.json(verifiedCatalog())); await first;
  assert.deepEqual(connection.provider.getModels(), []);
  connection.dispose();
});

test("unconfigured and offline providers do not fetch; Pi auth resolves stored keys before env", async () => {
  let calls = 0;
  const connection = createInferCloudProvider({ env: () => ({ PI_OFFLINE: "1" }), fetch: async () => { calls++; return Response.json(verifiedCatalog()); } });
  await refreshProvider(connection.provider);
  await connection.provider.refreshModels?.(refreshContext({ allowNetwork: false }));
  await connection.provider.refreshModels?.(refreshContext());
  assert.equal(calls, 0);
  assert.deepEqual(connection.provider.getModels(), []);
  const result = await connection.provider.auth.apiKey?.resolve({
    ctx: { env: async (name) => environment()[name as keyof ReturnType<typeof environment>], fileExists: async () => false },
    credential: { type: "api_key", key: "stored-key" }, signal: new AbortController().signal,
  });
  assert.equal(result?.auth.apiKey, "stored-key");
  assert.equal(result?.env?.INFERCLOUD_BASE_URL, DEFAULT_BASE_URL);
  connection.dispose();
});

test("streaming preserves profile headers and budgets and makes no automatic retry", async () => {
  let inferenceCalls = 0;
  const connection = createInferCloudProvider({ env: environment, fetch: async (input, init) => {
    if (String(input).includes("/models?")) return Response.json(verifiedCatalog());
    inferenceCalls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-key");
    assert.equal(headers.get("x-infercloud-routing-profile"), "text-coding");
    assert.equal(headers.get("x-infercloud-min-context-tokens"), "8192");
    assert.equal(headers.get("x-infercloud-min-output-tokens"), "512");
    const payload = JSON.parse(String(init?.body)) as { max_tokens?: number; max_completion_tokens?: number };
    assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 512);
    return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
  } });
  await connection.provider.refreshModels?.(refreshContext());
  const model = connection.provider.getModels()[0]!;
  const result = await connection.provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }), {
    apiKey: "synthetic-key", maxRetries: 5,
    headers: { "X-InferCloud-Routing-Profile": null, "X-InferCloud-Min-Context-Tokens": "1", Authorization: "Bearer wrong-key" },
  }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(inferenceCalls, 1);
  const oversized = await connection.provider.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: "synthetic-key", maxTokens: 513 }).result();
  assert.equal(oversized.stopReason, "error");
  assert.match(oversized.errorMessage ?? "", /verified model limit/);
  assert.equal(inferenceCalls, 1);
  connection.dispose();
});

test("native model sampling overrides reach inference without changing verified limits", async () => {
  let calls = 0;
  const connection = createInferCloudProvider({ env: environment, fetch: async (url, init) => {
    if (String(url).includes("/models?")) return Response.json(verifiedCatalog());
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.temperature, 0);
    assert.equal(payload.top_p, 0.8);
    assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 512);
    assert.equal(new Headers(init?.headers).get("X-InferCloud-Min-Context-Tokens"), "8192");
    return Response.json({ error: { code: "provider_unavailable" } }, { status: 503 });
  } });
  await connection.provider.refreshModels?.(refreshContext());
  const model = { ...connection.provider.getModels()[0]!, samplingParams: { temperature: 0.6, top_p: 0.8 }, samplingParamsByThinkingLevel: { off: { temperature: 0 } } };
  await connection.provider.streamSimple(model, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
  assert.equal(calls, 1);
  connection.dispose();
});

test("cancelled refresh cannot install its response, and disposing aborts discovery", async () => {
  let finish: ((response: Response) => void) | undefined;
  let fetchSignal: AbortSignal | null | undefined;
  const connection = createInferCloudProvider({ env: environment, fetch: async (_input, init) => {
    fetchSignal = init?.signal;
    return new Promise<Response>((done) => { finish = done; });
  } });
  const controller = new AbortController();
  const pending = connection.provider.refreshModels!(refreshContext({ signal: controller.signal }));
  await Promise.resolve();
  controller.abort(); finish!(Response.json(verifiedCatalog())); await pending;
  assert.deepEqual(connection.provider.getModels(), []);
  const next = connection.provider.refreshModels!(refreshContext());
  await Promise.resolve();
  connection.dispose();
  assert.equal(fetchSignal?.aborted, true);
  finish!(Response.json(verifiedCatalog())); await next;
  assert.deepEqual(connection.provider.getModels(), []);
});


test("credential rotation during discovery cannot expose the prior project's catalog", async () => {
  let env = environment();
  let finish: ((response: Response) => void) | undefined;
  const connection = createInferCloudProvider({ env: () => env, fetch: async () => new Promise<Response>((done) => { finish = done; }) });
  const pending = connection.provider.refreshModels!(refreshContext());
  await Promise.resolve();
  env = { ...env, INFERCLOUD_API_KEY: "new-project-key" };
  finish!(Response.json(verifiedCatalog())); await pending;
  assert.deepEqual(connection.provider.getModels(), []);
  connection.dispose();
});

test("availability notices follow credential scope and the catalog freshness deadline", async () => {
  let now = Date.now();
  let env = environment();
  const notices: (string | undefined)[] = [];
  const connection = createInferCloudProvider({ env: () => env, now: () => now,
    fetch: async () => Response.json(projectCatalog(now)), onAvailabilityChange: (notice) => notices.push(notice),
  });
  await connection.provider.refreshModels?.(refreshContext());
  const old = connection.provider.getModels()[0]!;
  assert.match(connection.getAvailabilityNotice() ?? "", /synthetic-vision/);
  assert.equal(notices.length, 1);
  now += 60_000;
  assert.equal(connection.getAvailabilityNotice(), undefined);
  await connection.provider.refreshModels?.(refreshContext());
  env = { ...env, INFERCLOUD_API_KEY: "different-project" };
  assert.equal(connection.getAvailabilityNotice(), undefined);
  const rejected = await connection.provider.streamSimple(old, normalizeContext({ messages: [] }), { apiKey: "different-project" }).result();
  assert.ok(!rejected.errorMessage?.includes("synthetic-vision"));
  connection.dispose();
  assert.equal(connection.getAvailabilityNotice(), undefined);
  const afterShutdown = await connection.provider.streamSimple(old, normalizeContext({ messages: [] }), { apiKey: "synthetic-key" }).result();
  assert.ok(!afterShutdown.errorMessage?.includes("synthetic-vision"));
});

test("Pi cache-only refresh preserves matching in-flight discovery and invalidates a rotated credential", async () => {
  for (const rotate of [false, true]) {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((done) => { started = done; });
    const connection = createInferCloudProvider({ env: () => ({ INFERCLOUD_BASE_URL: "https://gateway.invalid/v1" }),
      fetch: async () => new Promise<Response>((done) => { finish = done; started(); }),
    });
    const pending = connection.provider.refreshModels!(refreshContext({ credential: { type: "api_key", key: "synthetic-original" } }));
    await fetching;
    await connection.provider.refreshModels!(refreshContext({ allowNetwork: false,
      credential: { type: "api_key", key: rotate ? "synthetic-replacement" : "synthetic-original" },
    }));
    finish(Response.json(verifiedCatalog())); await pending;
    assert.equal(connection.provider.getModels().length, rotate ? 0 : 1);
    connection.dispose();
  }
});
