import type { Provider } from "@earendil-works/pi-ai";

/** Direct-provider unit tests use a deterministic publication context. */
export async function refreshProvider(provider: Provider) {
  await provider.refreshModels?.({ allowNetwork: true, signal: new AbortController().signal,
    publish: async ({ update }) => { update?.(); return true; } });
}
