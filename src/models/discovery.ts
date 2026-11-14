import { UserFacingError } from "../errors.js";
import { gatewayErrorCode, gatewayFailure } from "../provider/errors.js";
import { mapModelCatalog, type CatalogMapping } from "./catalog.js";

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

class DiscoveryError extends UserFacingError {
  constructor(readonly code: "unauthorized" | "forbidden" | "unavailable" | "invalid_catalog" | "timeout" | "cancelled" | "network" | "billing" | "throttled") {
    const messages = {
      unauthorized: "InferCloud rejected the consumer API key. It may be invalid or revoked; reconnect with /login.",
      forbidden: "InferCloud denied access to this project's model catalog.",
      unavailable: "InferCloud model discovery is unavailable. Refresh the catalog to try again.",
      invalid_catalog: "InferCloud returned an invalid model catalog.",
      timeout: "InferCloud model discovery timed out.",
      cancelled: "InferCloud model discovery was cancelled.",
      network: "InferCloud model discovery could not connect to the gateway.",
      billing: gatewayFailure(402).message,
      throttled: gatewayFailure(429).message,
    };
    super(messages[code]);
    this.name = "DiscoveryError";
  }
}

/** No redirects, retries, persistent cache, or raw response/error diagnostics. */
export async function discoverModels(options: {
  baseUrl: string; apiKey: string; signal: AbortSignal;
  fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: number;
}): Promise<CatalogMapping> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  const url = new URL(`${options.baseUrl}/models`);
  url.searchParams.set("include", "metadata");
  url.searchParams.set("profile", "text-coding");
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", "Cache-Control": "no-store" },
      signal, redirect: "error",
    });
    if (!response.ok) {
      const failure = gatewayFailure(response.status, await gatewayErrorCode(response));
      throw new DiscoveryError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" :
        failure.code === "billing" ? "billing" : failure.code === "throttled" ? "throttled" : "unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DiscoveryError("invalid_catalog");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_CATALOG_BYTES) {
          await reader.cancel();
          throw new DiscoveryError("invalid_catalog");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    try {
      return mapModelCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")), options.now ?? Date.now());
    } catch { throw new DiscoveryError("invalid_catalog"); }
  } catch (error) {
    if (options.signal.aborted) throw new DiscoveryError("cancelled");
    if (timeout.aborted) throw new DiscoveryError("timeout");
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError("network");
  }
}
