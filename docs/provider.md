# Native InferCloud provider

The `infercloud` provider targets Pi 1.5.2 and its supported extension API.
`auth.apiKey.login` supplies Pi's native masked API-key flow; `refreshModels`
discovers the consumer project's verified text-coding models. Pi's OpenAI Chat
Completions implementation owns conversion, streaming, tools, and usage decoding.

## Registration and startup

Pi resolves startup defaults, CLI models, and scopes before its background catalog
refresh. The asynchronous extension factory uses Pi's public `ModelRuntime` to
compose the user `models.json`, resolve native credentials, and refresh only
InferCloud before registration completes. This primes the provider's in-memory
catalog for native defaults and scopes without copying authentication or config
parsers. It does not select a model, rewrite settings, persist catalogs, or create
a separate credential store. Offline startup skips network discovery.

After registration, Pi owns login/logout, availability, `/model`, `/scoped-models`,
defaults, and refresh. An extension hook refreshes the InferCloud catalog before
an InferCloud prompt to enforce current attestations and limits. Session shutdown
aborts active discovery and inference.

## Endpoints and credentials

The default endpoint is `https://api.infercloud.ai/v1`. Pi's `models.json` provider
`baseUrl` override takes precedence over `INFERCLOUD_BASE_URL`, which otherwise
supplies the native provider endpoint. URLs require HTTPS or loopback HTTP and an
explicit `/v1` suffix, without embedded credentials, query strings, or fragments.

Login uses a catalog GET to validate the supplied consumer key. It returns an
`api_key` credential with a provider-scoped endpoint binding to Pi, which persists
it in `auth.json`. Login never selects a model. A valid empty catalog yields a
notice and can retain credentials for later model availability. Cancellation or
failed validation leaves the existing native credential intact.

Stored credentials follow Pi's precedence. API-key interpolation in `models.json`
and environment authentication remain supported. Endpoint changes cannot silently
redirect a saved key: native login must validate a replacement at the new endpoint.
The extension does not consume the old private-preview connection file.

See [setup](setup.md) for the exact user flow and [Pi's native provider example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregisterprovidername-config).

## Discovery and limits

`GET /v1/models?include=metadata` returns project-eligible models and per-profile
availability. Pi consumes the verified `text-coding` subset, and displays notices
explaining other discovered models' configured tooling and missing verification.
The mapper requires fresh routing-enforced verification, explicit text,
streaming and tool support, verified context/output limits, and usable token
prices. Missing/unknown guarantees do not become defaults.

Discovery rejects redirects, caps responses at 2 MiB, uses a ten-second deadline,
and performs one request on current gateways. Older gateways lacking per-profile
metadata use one additional filtered profile lookup within the same deadline;
there are no retries. Catalogs stay in memory, expire at the earlier of
attestation expiry or sixty seconds, and invalidate on credential/endpoint changes.
Failed discovery clears availability. Cancelled or superseded publications cannot
restore stale entries. Cache-only refresh clears prior-project catalogs after
rotation/logout while retaining fresh state for an unchanged connection.

Pi composes `models.json` overrides above the provider. The availability filter
excludes IDs absent from discovery, mismatched endpoints, and inflated limits.
Inference independently rechecks the selected model, credential, expiry, and budget.
No manual override bypasses gateway admission, verification, health, billing,
rate limits, or project policy. See [model metadata](model-metadata.md).

## Streaming and errors

The extension delegates wire processing to Pi's built-in `openai-completions` API,
imported through the supported `pi-ai/compat` entry point. It enforces the
`text-coding` profile, discovered context/output minima, an explicit output budget,
no inference redirects, and no provider-level retries. The absolute request
deadline defaults to 120 seconds and honors caller cancellation.

Fixed diagnostics interpret bounded gateway error codes without raw payloads or
transport details. Partial content survives interrupted streams, and those errors
do not match Pi's automatic retry classifier. Only canonical pre-stream context
overflow permits Pi's normal recovery. Images and optional reasoning are not
enabled by this text-coding profile. Prices shown by Pi are estimates; the gateway's
captured prices and metered records determine charges.

## Verification

Default tests cover Pi-managed login/storage, cancellation and failed validation,
rotation/logout/restart, endpoint binding, native scopes, metadata mapping,
expiry, concurrent refreshes, and failure behavior. Stock Pi CLI checks cover
manual compatible-endpoint configuration, environment auth, native auth/defaults/
scopes, and installed archives through text/read/edit/bash/usage/cancellation.
The opt-in real gateway/PostgreSQL check verifies synthetic durable accounting.

Run `npm run verify`. Live-model evidence remains pending; see
[compatibility](compatibility.md). Synthetic checks do not establish a production
model's capabilities or authorize a production attestation.
