# Model discovery contract and mapping

The gateway's additive `GET /v1/models?include=metadata` response supplies the
version 1 `infercloud` object on each model. Basic `/v1/models` remains usable by
other OpenAI-compatible clients. Discovery is authenticated with the consumer
key and uses only that key's default project routing policy.

The authoritative contract lives in InferCloud's
`api/openapi/infercloud.v1.yaml` and `docs/model-metadata.md`. This adapter's
`src/models/catalog.ts` validates the fields it consumes at runtime. The mapper
performs no networking, credential handling, or provider registration.

## Required guarantees for text coding

The mapper admits a model only when all of the following hold:

- Metadata schema version is `1` and scope is `ProjectEligibleOfferings`.
- `routingEnforced` is `true` and `routingProfile` is `text-coding`.
- `verificationExpiresAt` is valid and still in the future.
- Chat completions, streaming, tool calling, and text input are `Supported`.
- Context and output limits are positive safe integers labelled `Verified`.
- Output limits fit within the context window.
- All four token price ranges are known, valid nonnegative USD decimal rates.

Missing metadata, legacy catalogs, unsupported schema versions, duplicate model
IDs, and unmet guarantees are excluded with fixed reason codes. No default
context window, tool capability, or free token price is invented. Invalid catalog
envelopes produce a fixed error without reflecting their body.

Unprofiled InferCloud discovery retains top-level `routingEnforced: false`,
`Unknown` capabilities, and `ProviderReported` or `Unknown` limits. Its additive
`profiles["text-coding"]` entry supplies availability, reason codes, verified limits,
capabilities, expiry and prices for the compatible route subset. The mapper uses
that subset's metadata only when `available` is true; it never substitutes the
general catalog's limits or prices. Legacy filtered profile responses remain
supported through a bounded fallback lookup.

`tooling.state` is provider-reported configuration (`Enabled`, `Disabled`, `Mixed`,
or `Unknown`), separate from verified `capabilities.toolCalling`. Excluded models
produce bounded availability notices at login, startup and changed refreshes.
Only recognized reason codes are rendered; raw error prose is not displayed.
These models remain unselectable for coding until all required guarantees pass.

Profile discovery requires a fresh platform-admin attestation bound to
the approved deployment and mesh identity. Real operators must run compatibility
and limit checks and retain evidence before attesting. Synthetic test records do
not qualify as verification of a real model/runtime.

## Pi model values

Accepted models become Pi chat model definitions using `openai-completions`.
The verified limits map directly to `contextWindow` and `maxTokens`. Every model
also carries `X-InferCloud-Routing-Profile: text-coding`,
`X-InferCloud-Min-Context-Tokens`, and `X-InferCloud-Min-Output-Tokens` headers
using those discovered limits. The gateway checks the requirements for primary
and fallback routes and rechecks fresh evidence before usage reservation. Tool
history also selects the profile automatically. Expired, revoked, changed, or
smaller offerings are excluded; stale client discovery cannot waive that check.
The provider implementation must refresh discovery before metadata expires. The adapter
selects text input and disables optional reasoning controls; image and reasoning
features need their own tested runtime compatibility before they are enabled.

`Fixed` pricing maps to its rates. `Variable` pricing maps to the maximum of each
range and returns `UpperBoundEstimate` as its pricing basis. Every generated
display name explicitly labels pricing as estimated. The result preserves this
distinction for provider UI and onboarding work; it is never a binding quote.

Cache read/write rates are required rather than silently assumed to be free.
`Unknown` and non-token pricing cannot populate Pi's required numeric cost fields
and exclude the model. The gateway's price snapshot and metered usage determine
the actual bill.

Discovery describes currently eligible offerings and fallback phases. Refresh
timing, stale catalogs, credential resolution, and registration are handled by
the [provider implementation](provider.md). This mapper does not reserve
capacity or keep a model available between requests.
