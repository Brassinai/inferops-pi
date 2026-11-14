# Integration architecture

## Intended request path

```text
Pi tools and conversation loop
  -> InferCloud Pi provider extension
  -> InferCloud OpenAI-compatible gateway
  -> authorized, healthy provider-hosted offering
  -> streamed response back to Pi
```

Pi runs tools on the client's machine. InferCloud supplies model inference and
owns authentication, routing, capacity checks, usage recording, and billing.
Clients supply their InferCloud consumer API key. Provider cluster credentials
and mesh configuration remain behind the gateway.

## Package responsibilities

`src/index.ts` is the Pi extension entry point. Keep it small and delegate to
concrete modules as behavior is added:

- `auth/`: consumer key/URL validation; Pi owns native credential persistence.
- `models/`: project-aware discovery and verified capability metadata.
- `provider/`: native provider, refresh state, and built-in API delegation.

The native provider delegates streaming to Pi's OpenAI Chat Completions implementation. Pi calls this API adapter `openai-completions`. Refer to
the [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
and the locally installed types. Pi 1.5.2 exposes the API factory through its
`pi-ai/compat` extension import; direct API subpath imports do not load through
that version's extension aliases.

The development dependency records a Pi version for local checking. It does not
establish a tested compatibility range; record that range after integration
tests pass. Pi supplies host modules at runtime through peer dependencies.

## Gateway boundary

The existing gateway exposes `GET /v1/models` and `POST /v1/chat/completions`.
Use the inference gateway URL, including `/v1`, as the base URL. The dashboard
management API and inference gateway can have different origins.

The basic model list exposes model identifiers. `GET /v1/models?include=metadata&profile=text-coding`
adds InferCloud metadata schema version 1 for project-eligible context/output
limits, capabilities, and pricing. See [model metadata](model-metadata.md).
Provider reports and unknown capabilities are not verified execution guarantees.

Routing can select multiple offerings for one model. The text-coding profile requires fresh cloud-operator
attestations and preserves capabilities and requested limits across fallback offerings.
Capability enforcement belongs in InferCloud routing, not just the model picker.
Price estimates in Pi must account for variable offering prices and remain
distinct from the gateway's authoritative request price and usage records.

## Delivery boundary

Native provider login, Pi-managed credentials/defaults/scopes, discovery, and failure
normalization are implemented. See
[provider development](provider.md) for refresh, expiry, and credential behavior.
Real-model stock-Pi compatibility evidence remains pending; complete it before
client onboarding or production capability attestations.
Track cloud-side changes in the InferCloud repository and any `inferops cloud`
command changes in InferOps. Publishing and live deployment are separate release
steps after package validation.
