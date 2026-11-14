// Written into the disposable Pi user directory by the smoke runner.
// Never records prompts, tools, response content, headers, or credentials.
export const smokeAuditExtension = `
import { appendFileSync } from "node:fs";
export default function(pi) {
  let requestId;
  pi.on("after_provider_response", (event) => {
    const value = event.headers["x-request-id"] ?? event.headers["X-Request-ID"];
    requestId = typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
  });
  pi.on("message_end", (event) => {
    if(event.message.role !== "assistant") return;
    const usage = event.message.usage;
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const estimatedCostUSD = typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0 ? usage.cost.total : 0;
    appendFileSync(process.env.INFERCLOUD_PI_AUDIT_FILE, JSON.stringify({ requestId,
      inputTokens: count(usage?.input), outputTokens: count(usage?.output),
      cachedInputTokens: count(usage?.cacheRead), cacheWriteInputTokens: count(usage?.cacheWrite),
      estimatedCostUSD, aborted: event.message.stopReason === "aborted" }) + "\\n", {mode: 0o600});
    requestId = undefined;
  });
}
`;
