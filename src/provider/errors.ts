export interface GatewayFailure { code: string; message: string }
const fixed = (code: string, message: string): GatewayFailure => ({ code, message });

/** Interpret codes, never gateway/provider prose. Preserve safe admission failures for Pi's retry policy. */
export function gatewayFailure(status: number, code?: string): GatewayFailure {
  if (status === 401) return fixed("authentication", "InferCloud rejected the consumer key. It may be invalid or revoked; reconnect with /login.");
  if (status === 403) return fixed("forbidden", "InferCloud denied this project access. Ask the project owner to check permissions.");
  if (status === 402 || ["insufficient_balance", "spend_limit_exceeded", "billing_on_hold", "invalid_payment"].includes(code ?? "")) {
    return fixed("billing", "InferCloud billing blocked this request. Check the prepaid balance, spending limits, and billing holds in the dashboard.");
  }
  if (status === 429 || ["provider_rate_limited", "requests_per_minute_exceeded", "tokens_per_minute_exceeded", "concurrent_requests_exceeded"].includes(code ?? "")) {
    return fixed("throttled", "InferCloud is throttling requests. Wait before submitting another request or check the project's limits.");
  }
  if (status === 400 && code === "context_length_exceeded") {
    return fixed("context_length_exceeded", "context_length_exceeded: The conversation does not fit the model's context window. Compact it or start a smaller session.");
  }
  if (status === 503 && code === "no_compatible_offering") {
    // The gateway rejected admission without forwarding inference. Retain the
    // HTTP status so Pi can apply its own bounded, cancellable retry policy.
    return fixed("availability", "InferCloud has no eligible verified route (HTTP 503). Wait for capacity or refresh models if this persists.");
  }
  if (["no_compatible_offering", "capability_verification_unavailable", "mesh_route_denied", "routing_not_configured"].includes(code ?? "")) {
    return fixed("availability", "InferCloud has no eligible verified route for this request. Refresh models or ask the project owner to check routing.");
  }
  if (code === "provider_timeout") return fixed("deadline", "InferCloud did not finish within the request deadline. Start a new request when ready.");
  if (code === "provider_auth_failed") return fixed("provider_authentication", "The model deployment rejected InferCloud gateway authorization. Ask the project owner to contact support.");
  if (status === 503 && code === "provider_unavailable") {
    return fixed("availability", "InferCloud could not serve this request (HTTP 503). Wait for the provider to recover or refresh models if this persists.");
  }
  if (status >= 500) return fixed("availability", "InferCloud could not serve this request. Refresh models or start a new request later.");
  return fixed("rejected", "InferCloud rejected this request. Check the selected model, text-only input, and output budget.");
}

export async function gatewayErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 8192) { await reader.cancel(); return; }
      chunks.push(part.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || !("error" in body)) return;
    const error = body.error;
    if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return;
    return /^[a-z][a-z0-9_]{0,95}$/.test(error.code) ? error.code : undefined;
  } catch { return; }
  finally { reader.releaseLock(); }
}

export const interruptedMessage = "InferCloud response ended before completion. Review any partial output and start a new request when ready.";
