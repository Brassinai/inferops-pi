# InferCloud for Pi

Use your InferCloud consumer API key with the [Pi coding agent](https://pi.dev).
The provider discovers your project's verified coding models and delegates
inference to Pi's OpenAI Chat Completions adapter.

Discovery also explains project models that cannot yet be used for coding.
For example, `tooling enabled (provider reported); cloud capability verification
is missing or revoked` means configuration was discovered but the cloud has not
verified the complete coding profile. Login can succeed while no coding model is
selectable. Streaming support alone does not establish tool calling.

## Connect

Install the package supplied by your administrator using the
[preview archive instructions](docs/release.md), then start Pi:

1. Run `/login`, choose API-key authentication, select **InferCloud**, and paste
   your consumer key into Pi's masked prompt.
2. Run `/model` to choose an available verified model. Press `Ctrl+S` in the picker
   to save your default for new sessions.
3. Optionally use `/scoped-models` to choose the models cycled by `Ctrl+P`.
4. Submit your coding task. Pi executes tools locally; InferCloud supplies inference.

Pi owns authentication in its user-scoped `auth.json`, model defaults, scopes,
and `/logout`. Repeat `/login` after key rotation. The extension does not maintain
another credential file, model preference, or connection-command interface.
See [setup and troubleshooting](docs/setup.md).

The configured default gateway is `https://api.infercloud.ai/v1`. For a development
or custom InferCloud gateway, merge this provider entry into Pi's user-scoped
`~/.pi/agent/models.json` before logging in:

```json
{
  "providers": {
    "infercloud": { "baseUrl": "http://127.0.0.1:8081/v1" }
  }
}
```

Keep existing provider entries. The installed extension supplies the model list;
no manual model list or API key belongs in this endpoint configuration.
Remote endpoints require HTTPS. See [the example](examples/README.md).

## Status

Unpublished package candidate `0.1.0-rc.2`, targeting Pi **1.5.2** and Node.js 22.19 or newer.
Source: [Brassinai/inferops-pi](https://github.com/Brassinai/inferops-pi).
License selection and npm publication remain pending.
Synthetic tests exercise native authentication, model scoping, archive installation,
stock Pi text/read/edit/bash/usage/cancellation, and real gateway/PostgreSQL
accounting. Live model/runtime verification is still pending.

The provider uses Pi's supported native provider API because project-aware
model discovery requires executable behavior. Basic static compatible endpoints
can instead use Pi's `models.json`; see the official
[custom provider](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
and [model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
documentation. This package supplies dynamic discovery and verified metadata
while preserving Pi's normal user interface.

## Development and checks

```bash
npm ci --ignore-scripts
npm run verify
pi -e ./src/index.ts
```

Verification uses synthetic endpoints and credentials; default tests issue no
billable inference. Live checks require explicit opt-in; see
[gateway compatibility](docs/compatibility.md). Request-ID usage comparison uses
`npm run usage:reconcile -- <report.json> <usage.json>`.

For automation, supply `INFERCLOUD_API_KEY` through a secret manager or private
process environment. `INFERCLOUD_BASE_URL` is an optional endpoint override when
`models.json` does not configure one. `.env` is not loaded automatically. Pi's
stored or explicitly configured credentials take precedence over the ambient key.

## Layout

- `src/auth/`: endpoint and consumer-key validation.
- `src/models/`: bounded discovery and verified metadata mapping.
- `src/provider/`: native login, refresh, and built-in streaming delegation.
- `src/index.ts`: registration and refresh lifecycle; no custom agent loop.
- `tests/`: synthetic native-auth, protocol, and archive tests.
- `scripts/`: opt-in compatibility runner and exact usage reconciliation.
- `docs/`: architecture, setup, provider behavior, compatibility, and release.
- `examples/`: non-secret Pi endpoint configuration.

Pi loads the TypeScript entry point and supplies host libraries through peer
dependencies. Keep real credentials out of source files, project configuration,
command arguments, and logs. Local work is tracked in `tasks.md`, which remains
Git-ignored and excluded from the package.
