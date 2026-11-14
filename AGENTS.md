# AGENTS.md

Guidance for coding agents working on the InferCloud Pi integration.

## Scope and ownership

- Build a TypeScript provider extension for the Pi coding agent.
- This repository owns Pi provider registration, API-key setup, model discovery,
  capability mapping, integration tests, and package documentation.
- InferCloud owns its Go gateway, public API contracts, routing, model metadata,
  metering, and billing. InferOps owns `inferops cloud` CLI and SDK additions.
- Keep this package focused on the Pi adapter. Reuse Pi's supported API
  implementations instead of copying its agent loop or streaming client.
- Start with API-key authentication and verified text-based coding models.
  Follow the local `tasks.md` for implementation order when present.
- `tasks.md` is a local-only integration tracker. Never stage, commit, or publish
  it, including through force-add commands or the npm package file list.

## Contracts and security

- Check the current Pi documentation and installed types before using extension
  APIs. Keep host-provided Pi packages in peer dependencies, not runtime
  dependencies; install them as development dependencies for local checks.
- Treat the InferCloud OpenAPI contract and service behavior as authoritative.
  Do not assume additional capability fields already exist.
- Use project-scoped InferCloud consumer keys. Never require provider credentials
  or direct access to provider clusters.
- Do not commit or log credentials, authorization headers, request bodies,
  private conversation history, or provider response payloads.
- Never write secrets into a project's configuration. Use Pi's native `auth.apiKey.login` and `auth.json`, or environment variables.
- Follow Pi's built-in `/login`, `/logout`, `/model`, and `/scoped-models` flows.
  Do not add a separate credential store, model preference, or duplicate commands.
- Use Pi's `models.json` for custom provider endpoint configuration and preserve
  its composition/credential precedence; never redirect an endpoint-bound key.
- Reject unknown capabilities for features that require them. Do not fabricate
  context limits, tool support, reasoning support, or prices.
- Gateway billing is authoritative. Label client-side cost estimates accurately.
- Honor cancellation and timeouts for discovery and inference. Avoid retries
  that replay partially consumed inference streams.

## Implementation and verification

- Keep TypeScript strict and use explicit types at API boundaries.
- Add modules when concrete behavior needs them; avoid general SDK abstractions.
- Keep task status in documentation and source comments focused on behavior.
- Add focused tests for authentication, model metadata, streaming, tool use,
  cancellation, and error handling as those behaviors are implemented.
- Unit and default integration tests must use synthetic data and mock endpoints.
  Make billable live tests explicit and opt-in.
- Run `npm run verify` before completing changes. Report missing live coverage
  separately from checks that passed.
- Keep README examples aligned with implemented behavior and Pi's native flow.
