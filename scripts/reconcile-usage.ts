import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ClientUsage { requestId: string; inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; estimatedCostUSD: number; aborted: boolean }
interface MeteredUsage { requestId: string; gatewayInstanceId: string; status: string; inputTokens: number; outputTokens: number; amountUSD: string }
const invalid = () => new Error("Usage reconciliation failed: supply the smoke report and a matching completed gateway usage export, without duplicates or missing records.");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const requestID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
function money(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,24}\.\d{8}$/.test(value)) throw invalid();
  return BigInt(value.replace(".", ""));
}
function formatted(value: bigint) { const digits = value.toString().padStart(9, "0"); return `${digits.slice(0, -8)}.${digits.slice(-8)}`; }

/** Match exact request IDs. Canceled streams need authoritative usage, not a guessed zero charge. */
export function reconcileUsage(report: unknown, exported: unknown) {
  if (!record(report) || !Array.isArray(report.phases) || !Array.isArray(exported)) throw invalid();
  const clients: ClientUsage[] = [];
  for (const phase of report.phases) {
    if (!record(phase) || !Array.isArray(phase.requests)) throw invalid();
    for (const entry of phase.requests) {
      if (!record(entry) || !requestID(entry.requestId) || ![entry.inputTokens, entry.outputTokens, entry.cachedInputTokens, entry.cacheWriteInputTokens].every(count) ||
          typeof entry.aborted !== "boolean" || typeof entry.estimatedCostUSD !== "number" || !Number.isFinite(entry.estimatedCostUSD) || entry.estimatedCostUSD < 0) throw invalid();
      clients.push(entry as unknown as ClientUsage);
    }
  }
  if (!clients.length || new Set(clients.map((entry) => entry.requestId)).size !== clients.length || exported.length !== clients.length) throw invalid();
  const gateway = new Map<string, MeteredUsage>();
  for (const entry of exported) {
    if (!record(entry) || !requestID(entry.requestId) || !requestID(entry.gatewayInstanceId) ||
        !["Succeeded", "Canceled", "StreamingFailed", "Failed", "Unavailable", "RateLimited"].includes(String(entry.status)) ||
        !count(entry.inputTokens) || !count(entry.outputTokens) || gateway.has(entry.requestId)) throw invalid();
    money(entry.amountUSD);
    gateway.set(entry.requestId, entry as unknown as MeteredUsage);
  }
  let confirmed = 0; let cancelled = 0; let metered = 0n; let estimated = 0;
  for (const entry of clients) {
    const actual = gateway.get(entry.requestId);
    if (!actual) throw invalid();
    if (!entry.aborted) {
      if (actual.status !== "Succeeded" || actual.inputTokens !== entry.inputTokens + entry.cachedInputTokens + entry.cacheWriteInputTokens || actual.outputTokens !== entry.outputTokens) {
        throw new Error("Usage reconciliation failed: successful request token counts or terminal states differ from gateway accounting.");
      }
      confirmed++;
    } else {
      if (actual.status !== "Canceled" && actual.status !== "StreamingFailed") throw invalid();
      cancelled++;
    }
    metered += money(actual.amountUSD); estimated += entry.estimatedCostUSD;
  }
  return { schemaVersion: 1, requestCount: clients.length, successfulTokenChecks: confirmed, cancelledRequests: cancelled,
    gatewayAmountUSD: formatted(metered), piEstimatedCostUSD: estimated.toFixed(8),
    pricing: "Pi costs are estimates; frozen gateway prices and metered amounts are authoritative.",
    cancellation: "Cancelled-stream token counts may be incomplete in Pi; gateway terminal usage is retained, not replaced with zero." };
}

async function main() {
  try {
    if (process.argv.length !== 4) throw invalid();
    const report: unknown = JSON.parse(await readFile(process.argv[2]!, "utf8"));
    const usage: unknown = JSON.parse(await readFile(process.argv[3]!, "utf8"));
    process.stdout.write(JSON.stringify(reconcileUsage(report, usage), null, 2) + "\n");
  } catch { process.stderr.write("Usage reconciliation failed. Check report IDs, terminal records, token counts, and export format.\n"); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
