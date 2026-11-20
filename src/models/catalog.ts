import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type PiChatModel = Extract<ProviderModelConfig, { type?: "chat" }>;
export interface CatalogMapping {
  models: {
    definition: PiChatModel;
    verificationExpiresAt?: string;
  }[];
  unavailable?: { id: string; tooling: "Enabled" | "Disabled" | "Mixed" | "Unknown"; reason: string }[];
}

/** Profile metadata has its own route subset, token limits and price ranges. */
function codingMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return;
  if (value.routingProfile === "text-coding") return value;
  const profile = record(value.profiles) ? value.profiles["text-coding"] : undefined;
  if (!record(profile) || profile.available !== true) return;
  return { schemaVersion: value.schemaVersion, scope: value.scope, generatedAt: value.generatedAt,
    routingProfile: "text-coding", routingEnforced: true, verificationExpiresAt: profile.verificationExpiresAt,
    verificationValidity: profile.verificationValidity,
    capabilities: profile.capabilities, limits: profile.limits, pricing: profile.pricing };
}

const availabilityReasons: Record<string, string> = {
  capability_verification_missing_or_revoked: "cloud capability verification is missing or revoked",
  capability_verification_expired: "cloud capability verification has expired",
  capability_verification_invalid: "the stored capability verification is invalid",
  capability_deployment_changed: "the deployment no longer matches its saved verification",
  text_coding_not_verified: "streaming chat and tool calling have not all been verified",
};

// Current Cloud records are deployment-bound. Keep support for older gateways
// that explicitly advertise an expiring attestation; missing policy is not proof.
function validVerification(metadata: Record<string, unknown>, now: number): boolean {
  if (metadata.verificationValidity === "DeploymentBound") return true;
  if (metadata.verificationValidity !== undefined) return false;
  return typeof metadata.verificationExpiresAt === "string" &&
    Number.isFinite(Date.parse(metadata.verificationExpiresAt)) && Date.parse(metadata.verificationExpiresAt) > now;
}

function unavailableReason(metadata: unknown, now: number): string {
  if (!record(metadata)) return "capability metadata is unavailable";
  const profile = record(metadata.profiles) ? metadata.profiles["text-coding"] : undefined;
  if (record(profile) && profile.available === false && Array.isArray(profile.reasons)) {
    const reasons = [...new Set(profile.reasons.filter((reason): reason is string =>
      typeof reason === "string" && Object.hasOwn(availabilityReasons, reason)).map((reason) => availabilityReasons[reason]))];
    if (reasons.length) return reasons.join("; ");
  }
  const coding = codingMetadata(metadata);
  if (!coding) return "verified coding availability is not advertised";
  if (!validVerification(coding, now)) return "cloud capability verification is missing or expired";
  if (record(coding.capabilities) && coding.capabilities.toolCalling === "Unsupported") return "tool calling is unsupported";
  if (record(coding.capabilities) && coding.capabilities.toolCalling !== "Supported") return "tool calling has not been verified";
  if (!record(coding.limits) || verifiedTokens(coding.limits.contextWindow) === undefined || verifiedTokens(coding.limits.maxOutput) === undefined) {
    return "verified context or output limits are unavailable";
  }
  return "coding capability or pricing metadata is incomplete";
}

export function catalogNotice(mapping: CatalogMapping): string | undefined {
  if (!mapping.unavailable?.length) return mapping.models.length ? undefined : "InferCloud has no verified coding models available to this project.";
  const shown = mapping.unavailable.slice(0, 5).map(({ id, tooling, reason }) =>
    `${id}: tooling ${tooling.toLowerCase()} (provider reported); ${reason}.`).join("\n");
  const extra = mapping.unavailable.length > 5 ? `\n${mapping.unavailable.length - 5} more models are unavailable for coding.` : "";
  return `InferCloud discovered ${mapping.models.length + mapping.unavailable.length} project model(s); ${mapping.models.length} ready for Pi coding.\n${shown}${extra}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeModelID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}$/.test(value);
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
    if (!record(entry) || entry.object !== "model" || !safeModelID(modelId)) {
      continue;
    }
    if (counts.get(modelId) !== 1) { continue; }
    const metadata = codingMetadata(entry.infercloud);
    if (!record(metadata)) { continue; }
    if (metadata.schemaVersion !== 1 || metadata.scope !== "ProjectEligibleOfferings" ||
        typeof metadata.generatedAt !== "string" || !Number.isFinite(Date.parse(metadata.generatedAt)) ||
        typeof metadata.routingEnforced !== "boolean") {
      continue;
    }
    if (metadata.routingProfile !== "text-coding" || !metadata.routingEnforced) { continue; }
    if (!validVerification(metadata, now)) {
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
      ...(metadata.verificationValidity !== "DeploymentBound" && typeof metadata.verificationExpiresAt === "string" ?
        { verificationExpiresAt: metadata.verificationExpiresAt } : {}),
    });
  }
  const admitted = new Set(result.models.map(({ definition }) => definition.id));
  for (const entry of payload.data) {
    // Model IDs are catalog data. Bound notifications and exclude control/ANSI
    // sequences instead of rendering arbitrary provider prose or raw metadata.
    if (!record(entry) || entry.object !== "model" || !safeModelID(entry.id) || counts.get(entry.id) !== 1 || admitted.has(entry.id)) continue;
    const metadata = entry.infercloud;
    const state = record(metadata) && record(metadata.tooling) && metadata.tooling.source === "ProviderReported" ? metadata.tooling.state : undefined;
    const tooling = state === "Enabled" || state === "Disabled" || state === "Mixed" ? state : "Unknown";
    (result.unavailable ??= []).push({ id: entry.id, tooling, reason: unavailableReason(metadata, now) });
  }
  return result;
}
