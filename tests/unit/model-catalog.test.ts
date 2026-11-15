import assert from "node:assert/strict";
import test from "node:test";
import { catalogNotice, mapModelCatalog } from "../../src/models/catalog.js";
import { projectCatalog } from "../fixtures/catalog.js";

function catalog() {
  const range = (minUSD: string, maxUSD = minUSD) => ({ minUSD, maxUSD });
  return { object: "list", data: [{ id: "synthetic-coder", object: "model", infercloud: {
    schemaVersion: 1, generatedAt: "2026-11-13T12:00:00Z", scope: "ProjectEligibleOfferings", routingEnforced: true, routingProfile: "text-coding",
    verificationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    capabilities: { chatCompletions: "Supported", streaming: "Supported", toolCalling: "Supported",
      textInput: "Supported", imageInput: "Unknown", reasoning: "Unknown" },
    limits: { contextWindow: { tokens: 32768, verification: "Verified" }, maxOutput: { tokens: 4096, verification: "Verified" } },
    pricing: { state: "Fixed", currency: "USD", unit: "million_tokens", estimateOnly: true,
      input: range("0.10000000"), output: range("0.40000000"), cacheRead: range("0.10000000"), cacheWrite: range("0.10000000") },
  } }] };
}

test("map verified text-coding metadata without inventing limits or optional capabilities", () => {
  const mapped = mapModelCatalog(catalog());
  const model = mapped.models[0];
  assert.equal(model?.definition.contextWindow, 32768);
  assert.equal(model?.definition.maxTokens, 4096);
  assert.equal(model?.definition.reasoning, false);
  assert.deepEqual(model?.definition.headers, {
    "X-InferCloud-Routing-Profile": "text-coding",
    "X-InferCloud-Min-Context-Tokens": "32768",
    "X-InferCloud-Min-Output-Tokens": "4096",
  });
  assert.deepEqual(model?.definition.input, ["text"]);
  assert.deepEqual(model?.definition.cost, { input: 0.1, output: 0.4, cacheRead: 0.1, cacheWrite: 0.1 });
  assert.match(model?.definition.name ?? "", /estimated pricing/);
});

test("use labelled conservative estimates for variable offering prices", () => {
  const payload = catalog();
  const metadata = payload.data[0]!.infercloud;
  metadata.pricing.state = "Variable";
  metadata.pricing.input.maxUSD = "0.30000000";
  metadata.pricing.output.maxUSD = "1.20000000";
  const model = mapModelCatalog(payload).models[0];
  assert.equal(model?.definition.cost.input, 0.3);
  assert.equal(model?.definition.cost.output, 1.2);
  assert.match(model?.definition.name ?? "", /estimated pricing/);
});

test("exclude legacy, unsupported-version, unenforced, and unverified models", () => {
  assert.deepEqual(mapModelCatalog({ object: "list", data: [{ id: "legacy", object: "model" }] }).models, []);
  for (const mutate of [
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.schemaVersion = 2; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.routingProfile = ""; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.verificationExpiresAt = "2000-01-01T00:00:00Z"; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.routingEnforced = false; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.capabilities.toolCalling = "Unknown"; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.capabilities.textInput = "Unsupported"; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.limits.contextWindow.verification = "ProviderReported"; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.limits.maxOutput.tokens = 0; },
    (m: ReturnType<typeof catalog>["data"][number]["infercloud"]) => { m.limits.maxOutput.tokens = 65536; },
  ]) {
    const payload = catalog();
    mutate(payload.data[0]!.infercloud);
    assert.equal(mapModelCatalog(payload).models.length, 0);
  }
});

test("never convert missing, malformed, inconsistent, or non-token pricing into free inference", () => {
  for (const mutate of [
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.state = "Unknown"; },
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.unit = "request"; },
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.input.maxUSD = "NaN"; },
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.input.maxUSD = "-1.00000000"; },
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.input.maxUSD = "0.01000000"; },
    (p: ReturnType<typeof catalog>["data"][number]["infercloud"]["pricing"]) => { p.input.maxUSD = "0.20000000"; },
  ]) {
    const payload = catalog();
    mutate(payload.data[0]!.infercloud.pricing);
    const mapped = mapModelCatalog(payload);
    assert.deepEqual(mapped.models, []);
  }
});

test("reject malformed envelopes and duplicate IDs without reflecting raw payloads", () => {
  assert.throws(() => mapModelCatalog({ secret: "payload-canary" }), { message: "Invalid InferCloud model catalog." });
  const payload = catalog();
  payload.data.push(structuredClone(payload.data[0]!));
  assert.deepEqual(mapModelCatalog(payload).models, []);
  assert.deepEqual(mapModelCatalog({ object: "list", data: [] }), { models: [] });
});

test("project discovery distinguishes configured tooling from verified coding availability", () => {
  const mapped = mapModelCatalog(projectCatalog());
  assert.deepEqual(mapped.models.map(({ definition }) => definition.id), ["synthetic-coder"]);
  assert.deepEqual(mapped.unavailable, [{ id: "synthetic-vision", tooling: "Enabled", reason: "cloud capability verification is missing or revoked" }]);
  assert.match(catalogNotice(mapped) ?? "", /2 project model\(s\); 1 ready/);
  assert.match(catalogNotice(mapped) ?? "", /synthetic-vision: tooling enabled \(provider reported\)/);
});

test("availability notices whitelist reason codes and bound model identifiers", () => {
  const payload = projectCatalog();
  payload.data[1]!.infercloud.profiles["text-coding"].reasons = ["private-body-canary"];
  let mapping = mapModelCatalog(payload);
  assert.ok(!catalogNotice(mapping)?.includes("private-body-canary"));
  payload.data[1]!.id = "bad\u001b[31m\ncanary";
  mapping = mapModelCatalog(payload);
  assert.equal(mapping.unavailable, undefined);
});

test("profile prices and token limits are used instead of general catalog values", () => {
  const payload = projectCatalog();
  payload.data[0]!.infercloud.limits = { contextWindow: { tokens: 1, verification: "ProviderReported" }, maxOutput: { tokens: 1, verification: "ProviderReported" } };
  payload.data[0]!.infercloud.pricing = { ...payload.data[0]!.infercloud.pricing, state: "Unknown" };
  const model = mapModelCatalog(payload).models[0]!;
  assert.equal(model.definition.contextWindow, 8192);
  assert.equal(model.definition.maxTokens, 512);
  assert.equal(model.definition.cost?.input, 0.1);
  payload.data[0]!.infercloud.profiles["text-coding"].verificationExpiresAt = "2000-01-01T00:00:00Z";
  assert.equal(mapModelCatalog(payload).models.length, 0);
});
