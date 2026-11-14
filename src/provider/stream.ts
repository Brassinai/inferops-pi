import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type StreamOptions } from "@earendil-works/pi-ai";
import { gatewayErrorCode, gatewayFailure, interruptedMessage, type GatewayFailure } from "./errors.js";

/** Delegate the wire protocol to Pi; normalize transport diagnostics and terminal events only. */
export function guardedStream<T extends StreamOptions>(model: Model<"openai-completions">, options: T,
  run: (options: T) => AssistantMessageEventStream): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let failure: GatewayFailure | undefined;
  let receivedContent = false;
  const fetch = options.fetch ?? globalThis.fetch;
  const requestFetch: typeof globalThis.fetch = async (input, init) => {
    try {
      // Never follow an inference redirect with conversation contents or credentials.
      const response = await fetch(input, { ...init, redirect: "error" });
      if (response.ok) return response;
      failure = gatewayFailure(response.status, await gatewayErrorCode(response));
      return Response.json({ error: { code: failure.code, message: failure.message, type: "infercloud_error" } }, { status: response.status });
    } catch {
      failure = { code: "transport", message: "InferCloud could not connect or complete this request. Check the gateway connection before starting again." };
      throw new Error(failure.message);
    }
  };
  const deadlineExpired = () => options.signal?.aborted === true && options.signal.reason instanceof Error && options.signal.reason.name === "TimeoutError";
  const sanitize = (message: AssistantMessage, aborted = false) => {
    message.stopReason = aborted ? "aborted" : "error";
    message.errorMessage = aborted ? "InferCloud request cancelled." : deadlineExpired() ?
      "InferCloud response exceeded the request deadline. Review any partial output before starting again." : receivedContent ? interruptedMessage :
      failure?.message ?? "InferCloud response could not be completed. Refresh models or start a new request when ready.";
    delete message.diagnostics;
    return message;
  };
  void (async () => {
    try {
      const stream = run({ ...options, fetch: requestFetch, maxRetries: 0 });
      for await (const event of stream) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_start") receivedContent = true;
        if (event.type === "error") {
          const aborted = !deadlineExpired() && (options.signal?.aborted === true || event.reason === "aborted");
          output.push({ type: "error", reason: aborted ? "aborted" : "error", error: sanitize(event.error, aborted) });
        } else { output.push(event); }
      }
      output.end();
    } catch {
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const aborted = !deadlineExpired() && options.signal?.aborted === true;
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: sanitize(message, aborted) });
      output.end();
    }
  })();
  return output;
}
