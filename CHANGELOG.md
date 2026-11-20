# Changelog

## 0.1.0-rc.2 — unpublished candidate

- Accept saved deployment-bound Cloud verification without daily expiry, while
  retaining legacy expiry handling for older gateways and current routing checks.

- Discover the complete project catalog with per-profile availability; explain
  configured tooling and verification blockers without advertising unverified
  models as coding-ready. Retain bounded legacy profile discovery.
- Follow Pi's native provider route: `/login` with masked API-key validation,
  Pi-managed `auth.json`, `/logout`, `/model`, defaults, and `/scoped-models`.
- Configure custom endpoints through Pi's `models.json`; provide the standard
  hosted gateway by default and an optional automation environment override.
- Remove the separate credential store, model preferences, and custom connection
  commands from the earlier private preview. The old connection file is ignored.
- Remove the old UI status accessor, unused catalog diagnostic fields, and
  unnecessary internal exports after a source/dependency reachability audit.
- Preserve project-aware verified discovery, capability/limit enforcement,
  estimated prices, built-in streaming, deadlines, and sanitized errors.
- Verify native login/rotation/logout/restart/scopes, packed-package installation,
  tool streams, cancellation, and request-ID accounting with synthetic services.

The npm package is unpublished. License selection and real-model evidence
remain prerequisites for general client rollout and npm release. This candidate supersedes rc.1.
