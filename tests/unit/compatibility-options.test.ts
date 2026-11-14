import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { validateOptions } from "../../scripts/compatibility-smoke.js";

const options = { apiKey: "synthetic-key", model: "synthetic-coder", contextWindow: 8192, maxOutputTokens: 512 };

test("reject insecure remote URLs and credentials embedded in endpoints", () => {
  for (const baseUrl of ["http://remote.example/v1", "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret", "https://example.com/v1#secret", "https://example.com", "invalid"]) {
    assert.throws(() => validateOptions({ ...options, baseUrl }));
  }
  assert.equal(validateOptions({ ...options, baseUrl: "http://127.0.0.1:8081/v1" }).pathname, "/v1/");
  assert.equal(validateOptions({ ...options, baseUrl: "https://gateway.example/v1/" }).protocol, "https:");
});

test("require explicit model credentials and meaningful context/output budgets", () => {
  const base = { ...options, baseUrl: "http://127.0.0.1:8081/v1" };
  for (const override of [{ apiKey: "" }, { model: "" }, { contextWindow: NaN },
    { maxOutputTokens: 0 }, { maxOutputTokens: 8192 }, { timeoutMs: -1 }]) {
    assert.throws(() => validateOptions({ ...base, ...override }));
  }
});

test("the live command requires explicit opt-in and keeps the key out of diagnostics", async () => {
  const child = spawn(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("../../scripts/compatibility-smoke.ts", import.meta.url))], {
    env: { ...process.env, INFERCLOUD_PI_LIVE_TEST: "0", INFERCLOUD_API_KEY: "synthetic-secret-canary" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(output, /Set INFERCLOUD_PI_LIVE_TEST=1/);
  assert.ok(!output.includes("synthetic-secret-canary"));
});
