import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type PiChatModel = Extract<ProviderModelConfig, { type?: "chat" }>;
export interface CatalogMapping {
  models: {
    definition: PiChatModel;
    verificationExpiresAt: string;
  }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifiedTokens(value: unknown): number | undefined {
  if (!record(value) || value.verification !== "Verified" || typeof value.tokens !== "number" ||
      !Number.isSafeInteger(value.tokens) || value.tokens <= 0) return;
  return value.tokens;
}

function priceRange(value: unknown): { minimum: number; maximum: number } | undefined {
  if (!record(value)) return;
  const parse = (raw: unknown): number | undefined => {
    if (typeof raw !== "string" || !/^[0-9]+\.[0-9]{8}$/.test(raw)) return;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0 || rate > Number.MAX_SAFE_INTEGER) return;
    return rate;
  };
  const minimum = parse(value.minUSD);
  const maximum = parse(value.maxUSD);
  if (minimum === undefined || maximum === undefined || minimum > maximum) return;
  return { minimum, maximum };
}

/** Convert validated discovery metadata into text-coding models without Pi defaults. */
export function mapModelCatalog(payload: unknown, now = Date.now()): CatalogMapping {
  if (!record(payload) || payload.object !== "list" || !Array.isArray(payload.data)) {
    throw new Error("Invalid InferCloud model catalog.");
  }
  const result: CatalogMapping = { models: [] };
  const counts = new Map<string, number>();
  for (const entry of payload.data) {
    if (record(entry) && typeof entry.id === "string") counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  for (const entry of payload.data) {
    const modelId = record(entry) && typeof entry.id === "string" ? entry.id : "<invalid>";
    if (!record(entry) || entry.object !== "model" || !modelId.trim() || modelId === "<invalid>") {
      continue;
    }
    if (counts.get(modelId) !== 1) { continue; }
    const metadata = entry.infercloud;
    if (!record(metadata)) { continue; }
    if (metadata.schemaVersion !== 1 || metadata.scope !== "ProjectEligibleOfferings" ||
        typeof metadata.generatedAt !== "string" || !Number.isFinite(Date.parse(metadata.generatedAt)) ||
        typeof metadata.routingEnforced !== "boolean") {
      continue;
    }
    if (metadata.routingProfile !== "text-coding" || !metadata.routingEnforced) { continue; }
    if (typeof metadata.verificationExpiresAt !== "string" ||
        !Number.isFinite(Date.parse(metadata.verificationExpiresAt)) || Date.parse(metadata.verificationExpiresAt) <= now) {
      continue;
    }
    const capabilities = metadata.capabilities;
    const capabilityNames = ["chatCompletions", "streaming", "toolCalling", "textInput", "imageInput", "reasoning"];
    if (!record(capabilities) || capabilityNames.some((name) =>
      typeof capabilities[name] !== "string" || !["Unknown", "Supported", "Unsupported"].includes(capabilities[name]))) {
      continue;
    }
    if (["chatCompletions", "streaming", "toolCalling", "textInput"].some((name) => capabilities[name] !== "Supported")) {
      continue;
    }
    const limits = metadata.limits;
    const contextWindow = record(limits) ? verifiedTokens(limits.contextWindow) : undefined;
    const maxTokens = record(limits) ? verifiedTokens(limits.maxOutput) : undefined;
    if (contextWindow === undefined || maxTokens === undefined || maxTokens > contextWindow) {
      continue;
    }
    const pricing = metadata.pricing;
    if (!record(pricing) || (pricing.state !== "Fixed" && pricing.state !== "Variable") ||
        pricing.currency !== "USD" || pricing.unit !== "million_tokens" || pricing.estimateOnly !== true) {
      continue;
    }
    const input = priceRange(pricing.input);
    const output = priceRange(pricing.output);
    const cacheRead = priceRange(pricing.cacheRead);
    const cacheWrite = priceRange(pricing.cacheWrite);
    if (!input || !output || !cacheRead || !cacheWrite ||
        pricing.state === "Fixed" && [input, output, cacheRead, cacheWrite].some((rate) => rate.minimum !== rate.maximum)) {
      continue;
    }
    result.models.push({
      definition: {
        type: "chat", id: modelId, name: `${modelId} (estimated pricing)`, api: "openai-completions",
        input: ["text"], reasoning: false, contextWindow, maxTokens,
        headers: {
          "X-InferCloud-Routing-Profile": "text-coding",
          "X-InferCloud-Min-Context-Tokens": String(contextWindow),
          "X-InferCloud-Min-Output-Tokens": String(maxTokens),
        },
        cost: { input: input.maximum, output: output.maximum, cacheRead: cacheRead.maximum, cacheWrite: cacheWrite.maximum },
      },
      verificationExpiresAt: metadata.verificationExpiresAt,
    });
  }
  return result;
}
