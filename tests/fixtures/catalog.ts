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
