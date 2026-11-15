export function verifiedCatalog(now = Date.now()) {
  const rate = { minUSD: "0.10000000", maxUSD: "0.10000000" };
  return { object: "list", data: [{ id: "synthetic-coder", object: "model", owned_by: "infercloud", infercloud: {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), scope: "ProjectEligibleOfferings",
    routingEnforced: true, routingProfile: "text-coding", verificationExpiresAt: new Date(now + 3600_000).toISOString(),
    capabilities: { chatCompletions: "Supported", streaming: "Supported", toolCalling: "Supported", textInput: "Supported", imageInput: "Unknown", reasoning: "Unknown" },
    limits: { contextWindow: { tokens: 8192, verification: "Verified" }, maxOutput: { tokens: 512, verification: "Verified" } },
    pricing: { state: "Fixed", currency: "USD", unit: "million_tokens", estimateOnly: true,
      input: rate, output: rate, cacheRead: rate, cacheWrite: rate },
  } }] };
}

export function projectCatalog(now = Date.now()) {
  const coding = verifiedCatalog(now).data[0]!;
  const verified = coding.infercloud;
  const unknown = { chatCompletions: "Unknown", streaming: "Unknown", toolCalling: "Unknown", textInput: "Unknown", imageInput: "Unknown", reasoning: "Unknown" };
  const profile = { available: true, reasons: [] as string[], verificationExpiresAt: verified.verificationExpiresAt,
    capabilities: verified.capabilities, limits: verified.limits, pricing: verified.pricing };
  return { object: "list", data: [
    { ...coding, infercloud: { ...verified, routingProfile: undefined, routingEnforced: false, capabilities: unknown,
      tooling: { state: "Enabled", source: "ProviderReported" }, profiles: { "text-coding": profile } } },
    { id: "synthetic-vision", object: "model", owned_by: "infercloud", infercloud: { ...verified,
      routingProfile: undefined, routingEnforced: false, capabilities: unknown,
      tooling: { state: "Enabled", source: "ProviderReported" }, profiles: { "text-coding": { ...profile,
        available: false, reasons: ["capability_verification_missing_or_revoked"], capabilities: unknown } } } },
  ] };
}
