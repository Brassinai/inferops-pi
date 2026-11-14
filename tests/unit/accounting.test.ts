import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUsage } from "../../scripts/reconcile-usage.js";

function fixture() {
  return { report: { phases: [{ requests: [
    { requestId: "success", inputTokens: 70, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 30, estimatedCostUSD: 0.00019, aborted: false },
    { requestId: "cancel", inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, estimatedCostUSD: 0, aborted: true },
  ] }] }, usage: [
    { requestId: "success", gatewayInstanceId: "gateway", status: "Succeeded", inputTokens: 100, outputTokens: 30, amountUSD: "0.00019000" },
    { requestId: "cancel", gatewayInstanceId: "gateway", status: "StreamingFailed", inputTokens: 120, outputTokens: 5, amountUSD: "0.00014000" },
  ] };
}

test("reconcile uncached Pi input plus cache tokens to gross gateway input without erasing cancelled usage", () => {
  const { report, usage } = fixture();
  const result = reconcileUsage(report, usage.reverse());
  assert.equal(result.successfulTokenChecks, 1); assert.equal(result.cancelledRequests, 1);
  assert.equal(result.gatewayAmountUSD, "0.00033000"); assert.equal(result.piEstimatedCostUSD, "0.00019000");
});

test("accounting refuses missing, duplicate, unsettled, or inconsistent request evidence", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.usage.pop(); },
    (f: ReturnType<typeof fixture>) => { f.usage[1]!.requestId = "success"; },
    (f: ReturnType<typeof fixture>) => { f.usage[0]!.inputTokens = 99; },
    (f: ReturnType<typeof fixture>) => { f.usage[0]!.outputTokens = 31; },
    (f: ReturnType<typeof fixture>) => { f.usage[0]!.status = "Accepted"; },
    (f: ReturnType<typeof fixture>) => { f.report.phases[0]!.requests[0]!.requestId = ""; },
    (f: ReturnType<typeof fixture>) => { f.usage[0]!.amountUSD = "NaN"; },
    (f: ReturnType<typeof fixture>) => { f.usage[1]!.status = "Succeeded"; },
  ]) { const data = fixture(); mutate(data); assert.throws(() => reconcileUsage(data.report, data.usage)); }
});
