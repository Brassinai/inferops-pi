import { UserFacingError } from "../errors.js";
import type { ApiKeyCredential } from "@earendil-works/pi-ai";

export const DEFAULT_BASE_URL = "https://api.infercloud.ai/v1";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Validate configured gateway endpoints; never reflect their contents in errors. */
export function gatewayBaseUrl(raw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw ?? ""); }
  catch { throw new UserFacingError("Set INFERCLOUD_BASE_URL to the gateway URL ending in /v1."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, "").endsWith("/v1")) {
    throw new UserFacingError("Use an HTTPS gateway /v1 URL, or HTTP on loopback, without credentials or query parameters.");
  }
  return url.href.replace(/\/$/, "");
}

export function consumerKey(env: Environment, credential?: ApiKeyCredential): string | undefined {
  // Match Pi's standard precedence: its stored consumer key wins over ambient env.
  const value = credential?.key ?? env.INFERCLOUD_API_KEY;
  if (value === undefined || !value.trim()) return;
  const key = value.trim();
  if (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new UserFacingError("InferCloud API key contains invalid characters.");
  return key;
}
