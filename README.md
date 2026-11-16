# InferCloud for Pi

Connect [Pi](https://pi.dev) to your InferCloud project's coding models.
Requires Pi **1.5.2**, Node.js **22.19+**, and an InferCloud consumer API key.

## Get started

1. Install the [preview package](docs/release.md), then start `pi`.
2. Run `/login`, choose **InferCloud**, and enter your project API key.
3. Run `/model`, select a model, and send your task. Use `Ctrl+S` in the picker
   to save your default.

Models, verified capabilities, limits, and pricing come from InferCloud.
Pi runs tools locally and displays estimated USD costs; InferCloud's metered
billing records determine the actual charge.

See [setup](docs/setup.md) for custom gateways and troubleshooting, and
[compatibility](docs/compatibility.md) for supported behavior and test results.

## Development

```bash
npm ci --ignore-scripts
npm run verify
```

Default tests use synthetic endpoints. Live inference checks require explicit
opt-in. The preview package is not published to npm.
