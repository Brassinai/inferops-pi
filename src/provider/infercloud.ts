import { UserFacingError } from "../errors.js";
import { lazyStream, type ApiKeyCredential, type Model, type Provider, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { consumerKey, DEFAULT_BASE_URL, gatewayBaseUrl, type Environment } from "../auth/config.js";
import { discoverModels } from "../models/discovery.js";
import { catalogNotice } from "../models/catalog.js";
import { guardedStream } from "./stream.js";

export const PROVIDER_ID = "infercloud";
const CATALOG_MAX_AGE_MS = 60_000;
// A valid large context on a small CPU runtime can take several minutes to
// prefill. Keep a bounded overall deadline; native timeoutMs still overrides it.
const INFERENCE_TIMEOUT_MS = 10 * 60_000;

type CodingModel = Model<"openai-completions">;
interface CatalogEntry { model: CodingModel; expiresAt: number }

export function createInferCloudProvider(dependencies: {
  env?: () => Environment; fetch?: typeof globalThis.fetch; now?: () => number;
  discoveryTimeoutMs?: number;
  onAvailabilityChange?: (notice: string | undefined) => void;
  /** Initial endpoint composed by Pi before registration/cache refresh runs. */
  initialBaseUrl?: string;
} = {}) {
  const environment = dependencies.env ?? (() => process.env);
  const now = dependencies.now ?? Date.now;
  const shutdown = new AbortController();
  const api = openAICompletionsApi();
  let entries: CatalogEntry[] = [];
  let checkedAt = 0;
  let scope: { baseUrl: string; key: string; ambientKey: string | undefined; ambientUrl: string | undefined } | undefined;
  let configuredBaseUrl = gatewayBaseUrl(dependencies.initialBaseUrl ?? environment().INFERCLOUD_BASE_URL ?? DEFAULT_BASE_URL);
  let message = "Use /login to connect InferCloud, then /model to choose a verified coding model.";
  let generation = 0;
  let storedCredentialKey: string | undefined;
  let pendingScope: { key: string; baseUrl: string; generation: number } | undefined;
  let availabilityNotice: string | undefined;

  function currentEntries(): CatalogEntry[] {
    try {
      const env = { ...environment() };
      if (shutdown.signal.aborted || !scope || configuredBaseUrl !== scope.baseUrl || env.INFERCLOUD_BASE_URL !== scope.ambientUrl ||
          consumerKey(env) !== scope.ambientKey || now() >= checkedAt + CATALOG_MAX_AGE_MS) return [];
      return entries.filter((entry) => entry.expiresAt > now());
    } catch { return []; }
  }

  function currentNotice(): string | undefined {
    try {
      const env = { ...environment() };
      if (shutdown.signal.aborted || !scope || configuredBaseUrl !== scope.baseUrl || env.INFERCLOUD_BASE_URL !== scope.ambientUrl ||
        consumerKey(env) !== scope.ambientKey || now() >= checkedAt + CATALOG_MAX_AGE_MS) return;
      return availabilityNotice;
    } catch { return; }
  }

  function keyFor(credential?: ApiKeyCredential): string | undefined {
    const key = consumerKey(environment(), credential);
    const boundUrl = credential?.env?.INFERCLOUD_BASE_URL;
    if (key && boundUrl !== undefined && gatewayBaseUrl(boundUrl) !== configuredBaseUrl) {
      throw new UserFacingError("InferCloud gateway changed. Use /login to validate a key for the configured endpoint.");
    }
    return key;
  }

  const provider: Provider<"openai-completions"> = {
    id: PROVIDER_ID,
    name: "InferCloud",
    get baseUrl() { return gatewayBaseUrl(environment().INFERCLOUD_BASE_URL ?? DEFAULT_BASE_URL); },
    auth: { apiKey: {
      name: "InferCloud consumer API key",
      async login(interaction) {
        interaction.signal.throwIfAborted();
        const baseUrl = configuredBaseUrl;
        interaction.notify({ type: "info", message: "Enter a consumer API key for the configured InferCloud gateway. Model selection uses /model." });
        const apiKey = consumerKey({ INFERCLOUD_API_KEY: await interaction.prompt({ type: "secret", message: "InferCloud consumer API key" }) });
        if (!apiKey) throw new UserFacingError("Enter an InferCloud consumer API key.");
        const mapping = await discoverModels({ baseUrl, apiKey, signal: AbortSignal.any([interaction.signal, shutdown.signal]), now: now(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          ...(dependencies.discoveryTimeoutMs !== undefined ? { timeoutMs: dependencies.discoveryTimeoutMs } : {}),
        });
        interaction.signal.throwIfAborted();
        if (baseUrl !== configuredBaseUrl) throw new UserFacingError("InferCloud gateway changed during login. Run /login again.");
        const notice = catalogNotice(mapping);
        if (notice) interaction.notify({ type: "info", message: `The key is valid. ${notice}` });
        // Pi owns persistence in auth.json. Bind the key to its validated endpoint.
        return { type: "api_key", key: apiKey, env: { INFERCLOUD_BASE_URL: baseUrl } };
      },
      async resolve({ ctx, credential, signal }) {
        signal.throwIfAborted();
        const env = environment();
        const key = keyFor(credential) ?? consumerKey({ INFERCLOUD_API_KEY: await ctx.env("INFERCLOUD_API_KEY") ?? env.INFERCLOUD_API_KEY }, credential);
        signal.throwIfAborted();
        if (!key) return;
        return { auth: { apiKey: key }, env: { INFERCLOUD_BASE_URL: configuredBaseUrl }, source: credential?.key !== undefined ? "Stored InferCloud key" : "INFERCLOUD_API_KEY" };
      },
      async check(input) {
        try {
          const resolved = await provider.auth.apiKey!.resolve(input);
          return resolved ? { type: "api_key", ...(resolved.source ? { source: resolved.source } : {}) } : undefined;
        } catch { return; }
      },
    } },
    getModels: () => currentEntries().map(({ model }) => structuredClone(model)),
    filterModels(models, credential) {
      try {
        const key = keyFor(credential?.type === "api_key" ? credential : undefined) ?? (credential === undefined ? scope?.key : undefined);
        return scope?.key === key ? models.filter((model) => currentEntries().some((entry) =>
          entry.model.id === model.id && entry.model.baseUrl === model.baseUrl &&
          model.contextWindow <= entry.model.contextWindow && model.maxTokens <= entry.model.maxTokens)) : [];
      } catch { return []; }
    },
    async refreshModels(context) {
      if (shutdown.signal.aborted || context.signal.aborted) return;
      let version = generation;
      const signal = AbortSignal.any([context.signal, shutdown.signal]);
      const publishEmpty = async (status: string) => {
        if (signal.aborted || version !== generation) return;
        await context.publish({ update: () => { entries = []; scope = undefined; message = status; availabilityNotice = status; } });
      };
      try {
        signal.throwIfAborted();
        const env = { ...environment() };
        const baseUrl = gatewayBaseUrl(context.baseUrl ?? provider.baseUrl);
        const credential = context.credential?.type === "api_key" ? context.credential : undefined;
        if (!await context.publish({ update: () => { configuredBaseUrl = baseUrl; } })) return;
        const key = keyFor(credential);
        if (!context.allowNetwork) {
          const previousStoredKey = storedCredentialKey;
          storedCredentialKey = credential?.key;
          // Pi resolves models.json keys after the cache phase. An absent raw
          // credential alone does not mean a configured key was removed.
          const changed = key !== undefined && (scope && (scope.key !== key || scope.baseUrl !== baseUrl) || pendingScope && (pendingScope.key !== key || pendingScope.baseUrl !== baseUrl));
          if (changed || previousStoredKey !== undefined && credential?.key === undefined || scope && scope.baseUrl !== baseUrl) {
            version = ++generation;
            await publishEmpty("InferCloud connection changed. Open /model to refresh available models.");
          }
          return;
        }
        if (!key) { version = ++generation; await publishEmpty("Use /login to connect InferCloud, then /model to choose a verified coding model."); return; }
        version = ++generation;
        pendingScope = { key, baseUrl, generation: version };
        const mapping = await discoverModels({ baseUrl, apiKey: key, signal, now: now(),
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          ...(dependencies.discoveryTimeoutMs !== undefined ? { timeoutMs: dependencies.discoveryTimeoutMs } : {}),
        });
        if (signal.aborted || version !== generation) return;
        const next: CatalogEntry[] = mapping.models.map(({ definition, verificationExpiresAt }) => ({
          model: { id: definition.id, name: definition.name, api: "openai-completions", provider: PROVIDER_ID, baseUrl,
            reasoning: false, input: ["text"], cost: definition.cost, contextWindow: definition.contextWindow,
            maxTokens: definition.maxTokens, ...(definition.headers ? { headers: definition.headers } : {}),
          },
          expiresAt: Date.parse(verificationExpiresAt),
        }));
        await context.publish({ update: () => {
          entries = next;
          checkedAt = now();
          scope = { baseUrl, key, ambientKey: consumerKey(env), ambientUrl: env.INFERCLOUD_BASE_URL };
          availabilityNotice = catalogNotice(mapping);
          message = availabilityNotice ?? "InferCloud catalog is unavailable or stale. Refresh models before sending a request.";
        } });
        if (!signal.aborted && version === generation) dependencies.onAvailabilityChange?.(currentNotice());
      } catch (error) {
        if (signal.aborted) return;
        if (!context.allowNetwork) version = ++generation;
        // Errors from our boundaries are fixed strings, without raw HTTP payloads.
        const status = error instanceof UserFacingError ? error.message : "InferCloud model discovery failed. Refresh the connection and try again.";
        await publishEmpty(status);
        throw error instanceof UserFacingError ? error : new UserFacingError(status);
      } finally {
        if (pendingScope?.generation === version && context.allowNetwork) pendingScope = undefined;
      }
    },
    stream(model, context, options) {
      return lazyStream(model, async () => {
        const current = guardModel(model, options);
        const request = requestOptions(model, options);
        return guardedStream(current, request, (safe) => api.stream(current, context, safe));
      }, undefined, options?.signal);
    },
    streamSimple(model, context, options) {
      return lazyStream(model, async () => {
        const current = guardModel(model, options);
        const request = requestOptions(model, options);
        return guardedStream(current, request, (safe) => api.streamSimple(current, context, safe));
      }, undefined, options?.signal);
    },
  };

  function guardModel(model: CodingModel, options: StreamOptions | undefined): CodingModel {
    options?.signal?.throwIfAborted();
    const current = currentEntries().find((entry) => entry.model.id === model.id)?.model;
    if (!current || !scope || options?.apiKey !== scope.key) {
      const notice = options?.apiKey === scope?.key ? currentNotice() : undefined;
      throw new UserFacingError(notice ?? (!scope && !shutdown.signal.aborted ? message : "InferCloud catalog is unavailable or stale. Refresh models before sending a request."));
    }
    if (model.provider !== PROVIDER_ID || model.api !== "openai-completions" || model.baseUrl !== current.baseUrl ||
        model.contextWindow > current.contextWindow || model.maxTokens > current.maxTokens) {
      throw new Error("InferCloud model configuration changed. Refresh and reselect the model.");
    }
    if (options?.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || options.maxTokens > current.maxTokens)) {
      throw new Error("InferCloud output budget exceeds the verified model limit.");
    }
    return {
      ...structuredClone(current),
      // Pi composes user sampling settings through models.json. Preserve these
      // without accepting overrides of the endpoint or verified capabilities.
      ...(model.samplingParams ? { samplingParams: structuredClone(model.samplingParams) } : {}),
      ...(model.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: structuredClone(model.samplingParamsByThinkingLevel) } : {}),
    };
  }

  function requestOptions<T extends StreamOptions>(model: CodingModel, options: T | undefined) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(options?.headers ?? {})) if (value !== null) headers.set(name, value);
    // Preserve the limits Pi planned against, even if discovery now offers more.
    headers.set("X-InferCloud-Routing-Profile", "text-coding");
    headers.set("X-InferCloud-Min-Context-Tokens", String(model.contextWindow));
    headers.set("X-InferCloud-Min-Output-Tokens", String(model.maxTokens));
    headers.set("Authorization", `Bearer ${options?.apiKey ?? ""}`);
    const timeoutMs = options?.timeoutMs ?? INFERENCE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("InferCloud request timeout must be a positive integer.");
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([shutdown.signal, deadline, ...(options?.signal ? [options.signal] : [])]);
    return { ...options, signal, headers: Object.fromEntries(headers), maxTokens: options?.maxTokens ?? model.maxTokens,
      maxRetries: 0, timeoutMs,
      ...(dependencies.fetch && !options?.fetch ? { fetch: dependencies.fetch } : {}),
    };
  }

  return {
    provider,
    getAvailabilityNotice: currentNotice,
    dispose: () => { generation++; shutdown.abort(); entries = []; scope = undefined; },
  };
}
