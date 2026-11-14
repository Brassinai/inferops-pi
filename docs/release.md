# Installation and release

`infercloud-pi` version `0.1.0-rc.2` is an unpublished package candidate. Source
lives in [Brassinai/inferops-pi](https://github.com/Brassinai/inferops-pi). The npm
package remains unpublished; `private: true` prevents npm publication. License
selection is pending, and `UNLICENSED` remains in place.
Do not advertise `pi install npm:infercloud-pi` as an available install command.

## Preview archive

Maintainers can create an archive after verification:

```bash
npm ci --ignore-scripts
npm run verify
npm pack --ignore-scripts
```

Supply the resulting archive through your team's existing distribution channel.
Clients need Node.js 22.19 or newer and an existing Pi 1.5.2 installation. Install
the supplied archive into a permanent directory outside any project:

```bash
mkdir -p "$HOME/.local/share/infercloud-pi"
npm install --prefix "$HOME/.local/share/infercloud-pi" \
  --ignore-scripts --legacy-peer-deps --omit=dev --package-lock=false \
  /absolute/path/to/infercloud-pi-0.1.0-rc.2.tgz
pi install "$HOME/.local/share/infercloud-pi/node_modules/infercloud-pi"
pi
```

This package imports Pi's host libraries through peer dependencies; it has no
runtime npm dependencies. The install flags avoid installing another copy of Pi
or development dependencies. Keep the directory in place: Pi registers its path.

In Pi run `/login`, choose API-key authentication and InferCloud, then paste your
consumer key into the masked prompt. Run `/model` to select a verified model;
`Ctrl+S` saves the default. `/scoped-models` configures cycling. The hosted gateway
URL is configured by default. For a different gateway, set its provider `baseUrl`
in Pi's user `models.json` before login; see [setup](setup.md).

The archive check installs into a fresh directory, runs stock `pi install`, and
loads the installed provider with Pi-managed native credentials, model defaults,
and scopes. It executes text, read/edit/bash, usage, and cancellation against a
synthetic gateway. Focused native-runtime tests cover secret-prompt login,
validation/cancellation, rotation, endpoint changes, logout, and restart.
No archive check establishes real model compatibility.

To uninstall, use `/logout` to remove Pi's saved InferCloud credential if desired,
then run `pi remove` with the same package directory supplied to `pi install`.
Revoke compromised or unwanted keys in InferCloud. Environment/configured keys
are independent credential sources and must be removed separately.

## Compatibility and CI

The supported Pi version is exactly **1.5.2**. Other versions have not been
validated; all host peer and development versions are pinned together. The
standard workflow runs on Ubuntu and macOS with Node 22.19.0 and 24. These are
configured CI jobs, not a claim that remote jobs have already run.

The manual `Synthetic gateway accounting` workflow also checks out InferCloud
and runs stock Pi through its real gateway and PostgreSQL store with synthetic
accounts and a mock model. Choose a cloud commit containing
`TestPiGatewayAccountingPostgres`. If InferCloud is private, configure the
`INFERCLOUD_READ_TOKEN` Actions secret with read access to that repository.
The default workflow token only has access to its own repository. No production
key, model, or billing service is required.

## Before public release

1. Finalize the package name and license, add the approved license file, and
   confirm npm name availability. Repository, issue tracker, and homepage metadata
   point to `Brassinai/inferops-pi`; the npm package name is `infercloud-pi`.
2. Merge/deploy the cloud contracts and enforce verified routing. Obtain real
   model/runtime evidence and retain the corresponding platform attestation.
3. Run the extension live smoke check and exact request-ID reconciliation in
   [compatibility](compatibility.md). Confirm upstream cancellation and released
   capacity. Record versions, deployment revisions, and results without secrets.
4. Run both repositories' verification and CI, including the PostgreSQL
   accounting job. Repeat the archive install check for the final version.
5. Finalize the release version/changelog, remove `private: true` when approved,
   then publish/tag through the owner-approved release process. Update dashboard
   installation instructions with the published, pinned source.

The manifest intentionally prevents publishing while these prerequisites remain
open. No publishing credentials, registry writes, remote creation, or deployment
are part of local verification. The local tracker is ignored by Git and excluded
from the archive, along with tests, scripts, CI, and credentials.
