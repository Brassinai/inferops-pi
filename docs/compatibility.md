# Gateway compatibility

## Current evidence

The default automated checks use stock Pi 1.5.2 against a synthetic HTTP endpoint,
including the installed archive. An additional opt-in cross-repository test uses
the real Go gateway and a disposable PostgreSQL database with a mock model.
Neither uses a live model or incurs inference charges.

| Check | Automated evidence | Live InferCloud evidence |
| --- | --- | --- |
| Bearer key and authorized model discovery | Synthetic endpoint | Local deployment checked, 2026-11-16 |
| OpenAI Chat Completions text streaming | Stock Pi with synthetic SSE | Provider and cloud streaming tool/result probes passed |
| Fragmented tool-call arguments | Stock Pi with synthetic SSE | Pending |
| Interleaved calls and split UTF-8 bytes | Built-in Pi adapter with synthetic SSE | Pending |
| Read, edit, bash, and replayed tool results | Real Pi tools in disposable files | Current 0.8B model failed the complete task; protocol probes passed |
| Streamed input/output and cached tokens | Synthetic counters; real gateway/PostgreSQL reconciliation | Two successful Pi requests reconciled to gateway token records; live cache hits not separately exercised |
| Abort after the first text delta | Pi abort and closed HTTP stream | Pi abort, gateway terminal usage and capacity release checked; upstream cancellation timing not separately measured |

The InferCloud gateway also has a focused Go test covering forwarded tools,
tool-result history, streamed tool-call bytes, usage inclusion, and finalized
token counts. It uses a synthetic authenticated store and provider response.
The database check covers durable synthetic accounting as described below. These
suites do not establish real model/runtime compatibility or hosted billing.

The local Qwen3.5 0.8B deployment was checked with a 16,384-token context window
and 256-token output budget. Its streamed structured calls and fresh tool-result
nonce passed on provider and consumer routes. Normal Pi discovery advertised
those verified limits. This establishes API compatibility for that deployment;
the model's failure on the full file-editing fixture remains a coding-quality
limitation. Other rows marked pending require their own live evidence.
The normal installed extension also completed a real read/tool-result loop and
an RPC cancellation. Three admission failures recovered through Pi's native
retry policy and carried zero gateway charges. The two successful requests and
one cancellation were reconciled by exact gateway request IDs.

A later check used the installed extension with normal system context, skill
and resource discovery, and default tool definitions. The greeting completed
with one successful request (7,317 input tokens and 24 output tokens), no model
errors, and no tool actions; the cold CPU run took approximately 85 seconds.
The 8,192-token deployment had rejected Pi's larger request estimate. Its real
context was increased to 16,384, checked with 15,917 prompt tokens and an
oversized-input rejection, and attested again. The gateway now distinguishes
context overflow from transient unavailability and uses a verified-context
capacity burst while retaining configured quotas and measured sustained refill.


## Default verification

From the repository checkout:

```bash
npm ci --ignore-scripts
npm run verify
```

The integration test launches the locally installed Pi CLI. It uses an isolated
agent directory, restricts extension discovery to the tested package/audit helper, disables MCP/resource discovery and persistent
sessions, and does not read or change your normal Pi settings. Fixture responses
exercise real read/edit/bash tools in a temporary working directory.

## Live prerequisites

- A running InferCloud inference gateway and an authorized consumer project key.
- A healthy, project-routable coding model configured for tool calling.
- Verified context and output limits from that runtime's actual configuration.
- Access to the project's gateway usage records and the provider/runtime version.

Set these variables in the launching process's private environment:

| Variable | Meaning |
| --- | --- |
| `INFERCLOUD_API_KEY` | Project-scoped consumer API key |
| `INFERCLOUD_BASE_URL` | Inference gateway URL including `/v1`; defaults to local port 8081 |
| `INFERCLOUD_PI_MODEL` | Exact model ID returned by the key's `/v1/models` |
| `INFERCLOUD_PI_CONTEXT_WINDOW` | Verified context window in tokens |
| `INFERCLOUD_PI_MAX_OUTPUT_TOKENS` | Output budget within the verified runtime limit, leaving room for the prompt |
| `INFERCLOUD_PI_LIVE_TEST` | Must be `1` to enable live requests |
| `INFERCLOUD_PI_USE_EXTENSION` | Set to `1` to test the extension; otherwise use isolated manual Pi configuration |

The `.env.example` file is a reference; the runner does not load `.env`. Keep real
keys out of shell history, source files, examples, and reports. For remote
gateways use HTTPS. Embedded credentials, query parameters, and URL fragments
are rejected. Configure the inference gateway rather than the management API.

## Run the live check

The coding phase allows bounded recovery from tool errors, as Pi's agent loop
normally does. Success still requires successful read, edit, and bash tools,
the expected file edit, an unchanged verifier, and the verifier's passing output.
Reports count recovered tool errors without storing their raw contents.
Checks set temperature to zero through Pi's native model configuration, on both
provider and consumer paths. They establish protocol compatibility at that
setting; they do not certify coding quality across tasks or sampling settings.
`INFERCLOUD_PI_TIMEOUT_MS` adjusts each phase's deadline for slower CPU runtimes.
`INFERCLOUD_PI_REPORT_PATH` selects a private output file; an existing file is
never overwritten. These are operator test settings, not model capability claims.

After exporting the required configuration:

```bash
export INFERCLOUD_PI_LIVE_TEST=1
export INFERCLOUD_PI_USE_EXTENSION=1
npm run smoke:live
```

This sends billable inference requests. The runner first checks authorized model
discovery, then runs three fresh Pi sessions: a short text response, a
read/edit/bash task, and a long response aborted after its first text delta.
Automatic retries and compaction are disabled. Each phase has a two-minute
deadline. Missing usage counts, failed tools, incomplete edits, model errors,
or an unsuccessful abort fail the check.

The tool task edits a synthetic greeting module and executes a separate verifier.
The runner checks that the expected edit occurred and the verifier was unchanged.
It cleans up the temporary agent configuration and files on normal completion or
failure. In manual/environment mode, the key is passed through the child environment.
Extension live checks use Pi's native login API and temporary `auth.json`, then
launch the CLI without ambient key/URL credentials. Custom endpoint configuration
uses Pi's temporary `models.json`. No key is written into `models.json`, and all
temporary credentials are removed with the isolated agent directory.

Successful runs write an ignored `.tmp/compatibility/` JSON report with versions,
timestamps, model/limit configuration, successful tool counts, token counts,
estimated costs, abort status, and validated gateway request IDs for each
assistant response. Reports omit keys, prompts, tool arguments/results, and response
text. Provider errors are not reflected into runner diagnostics.

## Complete the gateway verification

A runner success alone does not complete task 1. Use the report's time window
and a dedicated test key to inspect the corresponding gateway usage records.
The management API supports consumer-key access to
`GET /v1/projects/{projectId}/usage`; use its documented origin and project scope.

Confirm requests belong to the expected model/offering, successful responses have
usage consistent with Pi's reported counts, immutable usage records were stored,
and the cancelled request finalized and released capacity. Partial cancelled
streams may lack a final provider usage event, so record how the gateway accounted
for them rather than assuming they consumed zero tokens.

Export exactly the terminal gateway records matching the report's request IDs
into this normalized JSON array (this example is synthetic):

```json
[
  {
    "requestId": "synthetic-request-1",
    "gatewayInstanceId": "synthetic-gateway-1",
    "status": "Succeeded",
    "inputTokens": 40,
    "outputTokens": 10,
    "amountUSD": "0.00004000"
  }
]
```

Use gateway-record values and retain eight decimal places for `amountUSD`.
Include the cancelled request's actual terminal record. Do not include credentials
or payloads. Save exports in the ignored `.tmp/compatibility/` directory, then run:

```bash
npm run usage:reconcile -- .tmp/compatibility/<report>.json .tmp/compatibility/usage.json
```

The command rejects missing, extra, duplicate, unsettled, or inconsistent records.
It compares successful gateway input to Pi's uncached input plus cache-read and
cache-write tokens, and checks output tokens exactly. Cancelled responses require
a `Canceled` or `StreamingFailed` terminal record; their Pi counts may be incomplete.
Gateway amounts remain authoritative and are summed using exact decimal arithmetic.
Pi's cost total is explicitly an estimate and need not equal the gateway charge.
This comparison does not independently verify the price calculation, durable event
storage, ledger reconciliation, or upstream capacity release; inspect those too.

Record the actual model/runtime versions, compatibility settings, request IDs,
gateway record results, and provider-side cancellation evidence in the local
`tasks.md` tracker. Keep that tracker ignored and outside the npm package.

## Extension protocol coverage

The default automated suite also loads `src/index.ts` into stock Pi 1.5.2 using
an isolated user directory. It discovers a synthetic verified profile catalog
and repeats the text, read/edit/bash, usage, and cancellation phases with the
actual InferCloud native provider extension. The test checks profile headers and token budgets.
This complements the manual stock configuration run and remains synthetic
protocol evidence. It does not verify a hosted model or reconcile real billing.

The extension is exercised with environment credentials, and through Pi's native
API-key login and `auth.json` with gateway/key environment variables unset in the
CLI. Native-auth runs rely on Pi's saved default and scoped model settings rather
than explicit CLI model flags. The packed-archive path repeats the native flow.
All use disposable synthetic user state. Focused runtime tests cover failed and
cancelled login, rotation, restart, logout, scoped resolution, and endpoint binding. Failure checks also
cover explicit overflow recovery, transport/error-body sanitization, malformed
or incomplete streams, and deadlines, with no automatic partial-stream replay.

## Synthetic durable-accounting check

With a disposable PostgreSQL 16 database and both checkouts installed, run from
the InferCloud repository:

```bash
# Export INFERCLOUD_TEST_DATABASE_URL for the disposable database first.
export INFERCLOUD_PI_TEST_DIRECTORY=/absolute/path/to/infercloud-pi
make test-pi-accounting
```

The test creates and drops a unique schema, applies migrations, seeds synthetic
accounts/mesh/attestations, and sends six native-authenticated stock-Pi requests through the real
authenticated Go gateway to a mock model. It confirms five successful token
totals including cache reads, one cancelled terminal record, immutable accepted
and completed events, exact request-ID matching, zero active reservations,
consumer-ledger totals, and idempotent event/ledger replay. It changes the
offering price after the first reservation and verifies its frozen original price.

This check passed locally against PostgreSQL 16 with Pi 1.5.2. The database was
removed afterward. The optional accounting CI workflow requires the corresponding
InferCloud commit and read access; see [release](release.md). The supported Pi
range is exactly `1.5.2` until another version passes these checks.
