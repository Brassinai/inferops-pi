import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { consumerKey, gatewayBaseUrl } from "../../src/auth/config.js";
import { discoverModels } from "../../src/models/discovery.js";
import { projectCatalog, verifiedCatalog } from "../fixtures/catalog.js";

const signal = () => new AbortController().signal;

test("validate explicit gateway URLs and literal consumer keys with Pi credential precedence", () => {
  assert.equal(gatewayBaseUrl("https://cloud.example.invalid/v1/"), "https://cloud.example.invalid/v1");
  assert.equal(gatewayBaseUrl("http://127.0.0.1:8081/v1"), "http://127.0.0.1:8081/v1");
  for (const value of [undefined, "http://remote.invalid/v1", "https://name:secret@host.invalid/v1", "https://host.invalid/v1?key=secret", "https://host.invalid/v1#token", "https://host.invalid"]) {
    assert.throws(() => gatewayBaseUrl(value), (error: unknown) => error instanceof Error && !error.message.includes("secret"));
  }
  assert.equal(consumerKey({ INFERCLOUD_API_KEY: "ambient" }, { type: "api_key", key: "stored" }), "stored");
  assert.equal(consumerKey({ INFERCLOUD_API_KEY: "  ambient  " }), "ambient");
  assert.equal(consumerKey({}), undefined);
  assert.equal(consumerKey({ INFERCLOUD_API_KEY: "ambient" }, { type: "api_key", key: "" }), undefined);
  assert.equal(consumerKey({ INFERCLOUD_API_KEY: "!echo-never-executed" }), "!echo-never-executed");
  assert.throws(() => consumerKey({ INFERCLOUD_API_KEY: "invalid\r\nkey" }));
});

test("discover project models and profile availability without redirects or retries", async () => {
  let calls = 0;
  const mapped = await discoverModels({ baseUrl: "https://gateway.invalid/v1", apiKey: "synthetic-key", signal: signal(),
    fetch: async (input, init) => {
      calls++;
      assert.equal(String(input), "https://gateway.invalid/v1/models?include=metadata");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-key");
      assert.equal(init?.redirect, "error");
      return Response.json(verifiedCatalog());
    },
  });
  assert.equal(calls, 1);
  assert.equal(mapped.models.length, 1);
  assert.ok(mapped.models[0]?.verificationExpiresAt);
});

test("discovery errors never reflect raw bodies, URLs, credentials, or network errors", async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    await assert.rejects(discoverModels({ baseUrl: "https://gateway.invalid/v1", apiKey: "secret-canary", signal: signal(),
      fetch: async () => { calls++; return new Response("secret-canary private-payload", { status }); },
    }), (error: unknown) => error instanceof Error && !/secret-canary|private-payload|gateway.invalid/.test(error.message));
    assert.equal(calls, 1);
  }
  for (const fetch of [
    async () => { throw new Error("network-secret-canary"); },
    async () => new Response("malformed-secret-canary"),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    async () => Response.json({ object: "other" }),
  ]) {
    await assert.rejects(discoverModels({ baseUrl: "https://gateway.invalid/v1", apiKey: "secret-canary", signal: signal(), fetch }),
      (error: unknown) => error instanceof Error && !error.message.includes("canary"));
  }
});

test("current gateways return selectable models and exclusion reasons in one catalog request", async () => {
  let calls = 0;
  const mapping = await discoverModels({ baseUrl: "https://gateway.invalid/v1", apiKey: "synthetic", signal: signal(),
    fetch: async () => { calls++; return Response.json(projectCatalog()); },
  });
  assert.equal(calls, 1);
  assert.equal(mapping.models.length, 1);
  assert.equal(mapping.unavailable?.[0]?.id, "synthetic-vision");
});

test("legacy gateways use a bounded profile lookup without reintroducing models outside the base catalog", async () => {
  let calls = 0;
  const first = verifiedCatalog();
  const metadata = first.data[0]!.infercloud as Partial<typeof first.data[0]["infercloud"]>;
  delete metadata.routingProfile;
  metadata.routingEnforced = false;
  const mapping = await discoverModels({ baseUrl: "https://gateway.invalid/v1", apiKey: "synthetic", signal: signal(),
    fetch: async (url) => {
      calls++;
      if (calls === 1) return Response.json(first);
      assert.equal(String(url), "https://gateway.invalid/v1/models?include=metadata&profile=text-coding");
      const second = verifiedCatalog();
      second.data.push({ ...structuredClone(second.data[0]!), id: "not-in-base-catalog" });
      return Response.json(second);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(mapping.models.map(({ definition }) => definition.id), ["synthetic-coder"]);
});

test("real HTTP discovery follows neither redirects nor slow responses and honors cancellation", async (t) => {
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/redirect/")) {
      response.writeHead(302, { location: "/target" }); response.end();
    } else if (request.url === "/target") {
      redirected = true; response.end("unexpected");
    }
    // Other routes deliberately stall for abort/timeout checks.
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await assert.rejects(discoverModels({ baseUrl: `${baseUrl}/redirect/v1`, apiKey: "synthetic", signal: signal() }), { code: "network" });
  assert.equal(redirected, false);
  await assert.rejects(discoverModels({ baseUrl: `${baseUrl}/v1`, apiKey: "synthetic", signal: signal(), timeoutMs: 30 }), { code: "timeout" });
  const controller = new AbortController();
  const pending = discoverModels({ baseUrl: `${baseUrl}/v1`, apiKey: "synthetic", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
});
