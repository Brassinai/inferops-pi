# Pi endpoint configuration

With the InferCloud provider package installed, merge `models.json.example`
into your Pi user directory's `models.json` to select a local/custom gateway.
Preserve all other provider entries. `PI_CODING_AGENT_DIR` changes that directory.
Use HTTPS for remote gateways; the example's HTTP URL is for loopback development.
Omit the override entirely to use `https://api.infercloud.ai/v1`.

Run `/login`, choose API-key authentication and InferCloud, and enter your
consumer key in Pi's masked prompt. Then run `/model` to select a verified model.
Use `Ctrl+S` in the picker to save the default and `/scoped-models` for cycling.
Pi owns credentials in `auth.json`; `/logout` removes the saved credential.

The extension supplies model discovery, verified limits, and estimated pricing.
Do not add a manual model list or a literal API key to this example. Configure the
inference gateway URL, which can differ from the dashboard management API origin.
After changing a gateway URL, authenticate again so the saved key is validated
for that endpoint.

Pi also supports static OpenAI-compatible endpoints entirely through `models.json`
without an extension. That advanced route requires maintaining actual model IDs,
verified context/output limits, capabilities, prices, and any routing headers.
This package follows Pi's native provider route to keep project-specific discovery
and verified metadata current automatically. The isolated manual compatibility
runner tests the protocol path without changing normal Pi configuration.

See the official [model configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
and [provider extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
documentation, [client setup](../docs/setup.md), and [compatibility checks](../docs/compatibility.md).
