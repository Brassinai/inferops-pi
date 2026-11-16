import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime, readStoredCredential, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createInferCloudProvider } from "../../src/provider/infercloud.js";
import { DEFAULT_BASE_URL } from "../../src/auth/config.js";
import { projectCatalog, verifiedCatalog } from "../fixtures/catalog.js";

const signal = () => new AbortController().signal;

function interaction(key = "synthetic-native-key", prompts: AuthPrompt[] = [], notices: string[] = []): AuthInteraction {
  return { signal: signal(), prompt: async (prompt) => { prompts.push(prompt); assert.equal(prompt.type, "secret"); return key; },
    notify: (event) => { if ("message" in event) notices.push(event.message); } };
}

test("native API-key login uses Pi's secret prompt, validates before persistence, and binds the endpoint", async () => {
  let calls = 0;
  const connection = createInferCloudProvider({ env: () => ({}), fetch: async (url, init) => {
    calls++; assert.ok(String(url).startsWith(DEFAULT_BASE_URL + "/models?"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-native-key");
    return Response.json(verifiedCatalog());
  } });
  try {
    const prompts: AuthPrompt[] = []; const notices: string[] = [];
    const login = interaction("synthetic-native-key", prompts, notices);
    const credential = await connection.provider.auth.apiKey!.login!({ ...login, signal: login.signal! });
    assert.deepEqual(credential, { type: "api_key", key: "synthetic-native-key", env: { INFERCLOUD_BASE_URL: DEFAULT_BASE_URL } });
    assert.equal(calls, 1); assert.equal(prompts.length, 1);
    assert.ok(!JSON.stringify({ prompts, notices }).includes("synthetic-native-key"));
    assert.deepEqual(connection.provider.getModels(), []); // Login does not select a model or publish an unowned catalog.
  } finally { connection.dispose(); }
});

test("valid login explains configured but unverified models without making them selectable", async () => {
  const payload = projectCatalog();
  payload.data.shift();
  const connection = createInferCloudProvider({ env: () => ({}), fetch: async () => Response.json(payload) });
  const notices: string[] = [];
  const credential = await connection.provider.auth.apiKey!.login!({ ...interaction("synthetic-key", [], notices), signal: signal() });
  assert.equal(credential.type, "api_key");
  assert.ok(notices.some((notice) => notice.includes("synthetic-vision: tooling enabled") && notice.includes("verification is missing")));
  assert.deepEqual(connection.provider.getModels(), []);
  connection.dispose();
});

test("Pi owns saved credentials, rotation, logout, restart, and scoped model resolution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "infercloud-native-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json"); const modelsPath = join(directory, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { infercloud: { baseUrl: "https://custom.invalid/v1" } } }));
  let status = 200; let empty = false; let calls = 0;
  const keys: string[] = [];
  const make = async () => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
    const initialBaseUrl = runtime.getProvider("infercloud")?.baseUrl;
    assert.equal(initialBaseUrl, "https://custom.invalid/v1");
    assert.ok(initialBaseUrl);
    // Match extension startup: compose the endpoint before registration's
    // asynchronous cache refresh can race with login.
    const connection = createInferCloudProvider({ env: () => ({}), initialBaseUrl, fetch: async (url, init) => {
      calls++; assert.ok(String(url).startsWith("https://custom.invalid/v1/models?"));
      keys.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(status === 200 ? empty ? { object: "list", data: [] } : verifiedCatalog() : { error: { code: "invalid_api_key", message: "private-canary" } }, { status });
    } });
    t.after(() => connection.dispose());
    runtime.registerNativeProvider(connection.provider);
    await runtime.refresh({ providers: ["infercloud"], allowNetwork: false });
    return { connection, runtime };
  };
  const { connection, runtime } = await make();
  await runtime.login("infercloud", "api_key", interaction());
  assert.equal(readStoredCredential("infercloud", authPath)?.type, "api_key");
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  const original = await readFile(authPath, "utf8");
  status = 401;
  await assert.rejects(runtime.login("infercloud", "api_key", interaction("synthetic-invalid-key")), (error: unknown) =>
    error instanceof Error && /invalid or revoked/.test(error.message) && !error.message.includes("private-canary"));
  assert.equal(await readFile(authPath, "utf8"), original);
  await assert.rejects(runtime.login("infercloud", "api_key", interaction("")));
  const cancel = interaction(); cancel.prompt = async () => { throw new Error("Login cancelled"); };
  await assert.rejects(runtime.login("infercloud", "api_key", cancel));
  assert.equal(await readFile(authPath, "utf8"), original);
  status = 200;
  await runtime.refresh({ providers: ["infercloud"] });
  assert.deepEqual((await runtime.getAvailable("infercloud")).map((model) => model.id), ["synthetic-coder"]);
  const scoped = await resolveModelScopeWithDiagnostics(["infercloud/synthetic-coder:off"], runtime);
  assert.equal(scoped.scopedModels.length, 1);
  assert.equal(scoped.scopedModels[0]?.model.provider, "infercloud");
  assert.equal(scoped.scopedModels[0]?.thinkingLevel, "off");

  const restarted = await make();
  await restarted.runtime.refresh({ providers: ["infercloud"] });
  assert.equal((await restarted.runtime.getAvailable("infercloud")).length, 1);
  await runtime.login("infercloud", "api_key", interaction("synthetic-rotated-key"));
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(keys.at(-1), "Bearer synthetic-rotated-key");
  const beforeLogout = calls;
  await runtime.logout("infercloud");
  assert.equal(readStoredCredential("infercloud", authPath), undefined);
  assert.deepEqual(await runtime.getAvailable("infercloud"), []);
  assert.deepEqual(connection.provider.getModels(), []);
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(calls, beforeLogout);

  empty = true;
  const notices: string[] = [];
  await runtime.login("infercloud", "api_key", interaction("synthetic-valid-empty-key", [], notices));
  assert.ok(notices.some((notice) => notice.includes("no verified coding models")));
  await runtime.refresh({ providers: ["infercloud"] });
  assert.deepEqual(await runtime.getAvailable("infercloud"), []);
});

test("models.json endpoint changes cannot redirect a saved key; native login validates a replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "infercloud-native-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json"); const modelsPath = join(directory, "models.json");
  let calls = 0;
  const connection = createInferCloudProvider({ env: () => ({}), fetch: async (url) => {
    calls++; assert.ok(String(url).startsWith(calls === 1 ? DEFAULT_BASE_URL : "https://replacement.invalid/v1"));
    return Response.json(verifiedCatalog());
  } });
  t.after(() => connection.dispose());
  const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
  runtime.registerNativeProvider(connection.provider);
  await runtime.refresh({ providers: ["infercloud"], allowNetwork: false });
  await runtime.login("infercloud", "api_key", interaction());
  await writeFile(modelsPath, JSON.stringify({ providers: { infercloud: { baseUrl: "https://replacement.invalid/v1" } } }));
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(calls, 1);
  assert.deepEqual(await runtime.getAvailable("infercloud"), []);
  await runtime.login("infercloud", "api_key", interaction("synthetic-new-endpoint-key"));
  assert.equal(calls, 2);
  const saved = readStoredCredential("infercloud", authPath);
  assert.equal(saved?.type === "api_key" && saved.env?.INFERCLOUD_BASE_URL, "https://replacement.invalid/v1");
});

test("Pi models.json API-key configuration remains available and native login takes precedence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "infercloud-configured-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { infercloud: { baseUrl: "https://custom.invalid/v1", apiKey: "synthetic-configured-key" } } }));
  let authorization = "";
  const connection = createInferCloudProvider({ env: () => ({}), initialBaseUrl: "https://custom.invalid/v1", fetch: async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Response.json(verifiedCatalog());
  } });
  t.after(() => connection.dispose());
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath, refreshOnCreate: false });
  runtime.registerNativeProvider(connection.provider);
  await runtime.refresh({ providers: ["infercloud"], allowNetwork: false });
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(authorization, "Bearer synthetic-configured-key");
  assert.equal((await runtime.getAvailable("infercloud")).length, 1);
  await runtime.refresh({ providers: ["infercloud"], allowNetwork: false });
  assert.equal((await runtime.getAvailable("infercloud")).length, 1);
  await runtime.login("infercloud", "api_key", interaction());
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(authorization, "Bearer synthetic-native-key");
  await runtime.logout("infercloud");
  await runtime.refresh({ providers: ["infercloud"] });
  assert.equal(authorization, "Bearer synthetic-configured-key");
  assert.equal((await runtime.getAvailable("infercloud")).length, 1);
});
