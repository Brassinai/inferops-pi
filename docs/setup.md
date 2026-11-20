# Setup and troubleshooting

Use Pi 1.5.2 with the installed InferCloud provider package. During the private
preview follow [archive installation](release.md); development checkouts can load
`pi -e ./src/index.ts` after `npm ci --ignore-scripts`.

## Native Pi login and model selection

1. Start Pi and run `/login`.
2. Choose API-key authentication and **InferCloud**. Paste a project-scoped
   consumer key into Pi's masked prompt.
3. Login validates the key with a catalog GET before returning credentials to Pi.
4. Run `/model` and select an available InferCloud model. Press `Ctrl+S` in the
   picker to save the default for future sessions.
5. Use `/scoped-models` to configure model cycling with `Ctrl+P` if desired.
6. Submit a prompt. Inference is billable; login/discovery alone sends no prompt.

The extension registers native `auth.apiKey.login` and `refreshModels` hooks.
Pi owns its dialogs, credential persistence, defaults, scoped models, and logout.
There are no additional InferCloud setup, model-selection, or disconnect commands.

A valid key with no eligible verified models can be saved. Pi then has no
InferCloud models to select until project routing and operator verification are
available. Invalid keys, failed validation, and cancellation before persistence
leave the prior Pi credential intact. The extension never chooses a model or
rewrites defaults after login, startup, or refresh.

## Endpoint configuration

The default is `https://api.infercloud.ai/v1`. To use another InferCloud gateway,
merge an endpoint override into your Pi user directory's `models.json`:

```json
{
  "providers": {
    "infercloud": { "baseUrl": "http://127.0.0.1:8081/v1" }
  }
}
```

Preserve other providers. `PI_CODING_AGENT_DIR` changes the user directory.
Remote gateways must use HTTPS; HTTP is accepted only for loopback development.
The URL must end in `/v1`, without credentials, query parameters, or fragments.
Use the inference gateway origin, which can differ from the management API.

The extension supplies project-visible models dynamically; do not copy a model
catalog into this file. Models added manually cannot bypass fresh verification,
profile limits, or project access. Pi composes user overrides above the provider,
and the extension rejects unverified IDs, endpoint mismatches, and inflated limits.

Pi's native `modelOverrides` can set sampling parameters for individual models,
for example `"modelOverrides": { "your-model-id": { "samplingParams": {
"temperature": 0 } } }` inside the `infercloud` provider. These settings reach
inference without changing the verified endpoint, capabilities, or limits.

For automation, `INFERCLOUD_BASE_URL` supplies an endpoint when `models.json` has
no override. A native-login credential carries its validated endpoint in Pi's
provider-scoped credential environment. Changing the endpoint requires `/login`
again: the extension will not forward the saved key to a different gateway.
Open `/model` or use `/reload` after changing configuration.

## Credentials, rotation, and removal

Pi persists returned credentials in its user-scoped `auth.json`, normally
`~/.pi/agent/auth.json`. The extension never opens or writes a second credential
store. Pi's file protection is not an encrypted keychain. Keep the Pi user directory
private and outside version control; trusted extensions execute within Pi.

Stored native credentials take precedence over `models.json` API-key configuration
and ambient environment credentials. Explicit runtime keys use Pi's runtime
credential path and must have a matching discovered catalog. `models.json` may
reference `$INFERCLOUD_API_KEY`; keep real keys out of configuration literals.

After rotating a key in InferCloud, repeat `/login` for InferCloud. Use `/logout`
to remove Pi's stored credential. Revoke keys in the dashboard to invalidate them
on the server. Environment or separately configured keys remain independent
sources: unset/remove them too when disconnecting entirely.

The previous private preview stored a connection at
`~/.pi/agent/infercloud/connection.json`. This version ignores that file and never
imports its key or model preference. Log in through Pi, save your model using the
native picker, and remove that obsolete file from your own Pi user directory.

## Automation

Supply secrets through a secret manager or private process environment:

```bash
export INFERCLOUD_BASE_URL=http://127.0.0.1:8081/v1
# Supply INFERCLOUD_API_KEY securely in the process environment.
pi -e ./src/index.ts --provider infercloud --model '<verified-model-id>' -p 'Your prompt'
```

Use a separate `PI_CODING_AGENT_DIR` for isolated automation. `.env` is not loaded
automatically. RPC/print clients should use native stored credentials or environment
configuration, without submitting keys in chat messages or command arguments.

## Failure behavior

| Condition | Action |
| --- | --- |
| Invalid or revoked key | Run `/login` again and verify the consumer project. |
| Gateway changed | Review `models.json` or environment configuration, then run `/login` for that endpoint. |
| Forbidden project access | Ask the project owner to check permissions. |
| Empty verified catalog | Check project routing, health, and current operator attestations. |
| Changed/revoked verification or unavailable route | Open `/model` to refresh; Cloud reuses saved verification for unchanged deployments, including after reconnect. |
| Throttling | Wait before submitting another request or review project limits. |
| Billing hold, balance, or spending limit | Review InferCloud dashboard billing. |
| Explicit context overflow | Let Pi recover normally, compact, or start a smaller conversation. |
| Discovery failure | Check the gateway and reopen `/model`; failed discovery clears the catalog. |
| Partial or interrupted inference | Review partial output before starting again; the adapter does not replay it. |
| Invalid Pi credential file | Follow Pi's credential-storage guidance, then use `/login`. |

An HTTP 503 with `no_compatible_offering` or `provider_unavailable` retains its
status in the safe error message so Pi's native bounded retry policy can wait
for capacity or provider recovery. This applies before any streamed content has
arrived. The adapter does not retry requests itself; partial streams and other
failures still require user action.

Inference has a ten-minute overall deadline, including established streams, so
verified large contexts on CPU runtimes can finish prefilling. Pi's native
`timeoutMs` option can shorten or replace that deadline; cancellation remains
immediate. Only explicit canonical
pre-stream overflow enables Pi's context recovery. Provider-level retries are
disabled, and fixed partial-stream messages avoid replay. Diagnostics
do not include provider bodies, credentials, or raw transport errors. Gateway
usage and charges remain authoritative, including failed or cancelled requests.

See Pi's official [model/authentication documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
and [native provider API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregisterprovidername-config).
