import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInferCloudProvider, PROVIDER_ID } from "./provider/infercloud.js";

export default async function infercloudExtension(pi: ExtensionAPI): Promise<void> {
  const startup = process.env.PI_OFFLINE === undefined ? await ModelRuntime.create({ refreshOnCreate: false }) : undefined;
  const initialBaseUrl = startup?.getProvider(PROVIDER_ID)?.baseUrl;
  let showAvailability: (notice: string | undefined) => void = () => {};
  const connection = createInferCloudProvider({ ...(initialBaseUrl ? { initialBaseUrl } : {}),
    onAvailabilityChange: (notice) => showAvailability(notice),
  });
  // Pi resolves startup defaults, CLI selection, and scopes before its background
  // refresh. Use its public runtime to compose models.json and native credentials
  // before publishing this dynamic provider. No separate credential store.
  if (startup) {
    startup.registerNativeProvider(connection.provider);
    // registerNativeProvider starts a cache-only refresh asynchronously. Prime the
    // composed provider directly so that refresh cannot cancel startup discovery.
    const provider = startup.getProvider(PROVIDER_ID);
    const signal = AbortSignal.timeout(10_000);
    try {
      const auth = await startup.getAuth(PROVIDER_ID, { signal });
      if (auth?.auth.apiKey && provider?.refreshModels) await provider.refreshModels({
        credential: { type: "api_key", key: auth.auth.apiKey, ...(auth.env ? { env: auth.env } : {}) },
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), allowNetwork: true, signal,
        publish: async ({ update }) => { if (signal.aborted) return false; update?.(); return true; },
      });
    } catch { /* Native /login and /model surface connection failures without blocking Pi startup. */ }
  }
  pi.registerProvider(connection.provider);
  let lastNotice: string | undefined;
  pi.on("session_start", async (_event, ctx) => {
    showAvailability = (notice) => {
      if (notice && notice !== lastNotice && ctx.hasUI) ctx.ui.notify(notice, "info");
      lastNotice = notice;
    };
    showAvailability(connection.getAvailabilityNotice());
  });
  pi.on("session_shutdown", () => { showAvailability = () => {}; connection.dispose(); });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID || process.env.PI_OFFLINE !== undefined) return;
    await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], signal: ctx.signal ?? AbortSignal.timeout(10_000) });
  });
}
