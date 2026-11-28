/**
 * Browser & Desktop "Open in SLEAP" deep-link parsing (issue #217).
 *
 * Supported entry points:
 *  - Browser URL:
 *      `…/?open=<encodeURIComponent(slpUrl)>[&name=<displayName>][#v=0&f=42&ticket=<oneTimeTicket>]`
 *  - Desktop custom URI scheme:
 *      `sleap://open?url=<encodeURIComponent(slpUrl)>[&name=<displayName>][&v=0&f=42][&ticket=<oneTimeTicket>]`
 *      `sleap://open?share=<shortcode>[&v=0&f=42][&ticket=<oneTimeTicket>]`
 *
 * `URLSearchParams.get` percent-decodes once, so `encodeURIComponent`
 * round-trips cleanly. Pure + browser-free so every branch is unit-testable.
 */

export interface OpenUrlRequest {
  /** Validated http(s) URL to the `.slp` file. */
  url: string;
  /** Optional friendly dataset display name (overrides URL basename). */
  name?: string;
  /** Optional one-time private handoff ticket (redeemed once for a `slp_ds_*` bearer). */
  ticket?: string;
  /** Optional initial video index to seek to after load. */
  videoIdx?: number;
  /** Optional initial frame index to seek to after load. */
  frameIdx?: number;
}

function isSafeHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseNonNegativeInt(raw: string | null): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Extract and validate the `?open=<url>` param from a `location.search` string.
 * Returns the decoded **http(s)** URL, or `null` when the param is absent,
 * malformed, relative, or a non-http(s) scheme (`file:`, `gs:`, `s3:`, …) — the
 * caller then boots normally instead of auto-opening. Pure + browser-free.
 */
export function readOpenParam(search: string): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get("open");
  } catch {
    return null;
  }
  return isSafeHttpUrl(value) ? value : null;
}

/**
 * Parse a full browser open request from `location.search` and `location.hash`.
 * Reads `?open=`, optional `?name=`, and `#ticket=` / `#v=` / `#f=` (with
 * fallback to `?ticket=` if a caller passed it in the query string).
 */
export function readOpenRequest(
  search: string,
  hash = ""
): OpenUrlRequest | null {
  const url = readOpenParam(search);
  if (!url) return null;

  const query = new URLSearchParams(search);
  const hashParams = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);

  const rawName = query.get("name")?.trim();
  const rawTicket = (hashParams.get("ticket") ?? query.get("ticket"))?.trim();
  const videoIdx = parseNonNegativeInt(hashParams.get("v") ?? query.get("v"));
  const frameIdx = parseNonNegativeInt(hashParams.get("f") ?? query.get("f"));

  return {
    url,
    ...(rawName ? { name: rawName } : {}),
    ...(rawTicket ? { ticket: rawTicket } : {}),
    ...(videoIdx !== undefined ? { videoIdx } : {}),
    ...(frameIdx !== undefined ? { frameIdx } : {}),
  };
}

/**
 * Strip `?open=`, `?name=`, `?ticket=`, and `#ticket=` from a browser URL
 * string, preserving the path (incl. `/latest/` or `/dev/`) and any `#v=&f=`
 * view-state fragment so the credential/open param isn't copied or re-triggered
 * on reload.
 */
export function stripOpenParamsFromUrl(href: string): string {
  const parsed = new URL(href);
  parsed.searchParams.delete("open");
  parsed.searchParams.delete("name");
  parsed.searchParams.delete("ticket");
  if (parsed.hash) {
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    if (hashParams.has("ticket")) {
      hashParams.delete("ticket");
      const nextHash = hashParams.toString();
      parsed.hash = nextHash ? `#${nextHash}` : "";
    }
  }
  return parsed.toString();
}

/**
 * Parse a desktop `sleap://` deep-link URL into an {@link OpenUrlRequest}.
 * Accepts:
 *   - `sleap://open?url=https://...`
 *   - `sleap://open?share=<6-char-shortcode>` (resolved against `defaultShareBaseUrl`)
 * Returns `null` for unknown hosts/actions, missing/invalid targets, or
 * non-http(s) URLs.
 */
export function parseSleapDeepLink(
  raw: string,
  defaultShareBaseUrl = "https://slp.sh"
): OpenUrlRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "sleap:") return null;
  // Support `sleap://open?...` (host="open") and `sleap:///open?...` (pathname="/open").
  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "open") return null;

  const params = parsed.searchParams;
  const hashParams = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash);

  let targetUrl: string | null = params.get("url") ?? params.get("open");
  if (!targetUrl) {
    const share = params.get("share")?.trim();
    if (share && /^[a-zA-Z0-9]{6}$/.test(share)) {
      const base = defaultShareBaseUrl.replace(/\/+$/, "");
      targetUrl = `${base}/${share}/labels.slp`;
    }
  }
  if (!isSafeHttpUrl(targetUrl)) return null;

  const rawName = params.get("name")?.trim();
  const rawTicket = (params.get("ticket") ?? hashParams.get("ticket"))?.trim();
  const videoIdx = parseNonNegativeInt(params.get("v") ?? hashParams.get("v"));
  const frameIdx = parseNonNegativeInt(params.get("f") ?? hashParams.get("f"));

  return {
    url: targetUrl,
    ...(rawName ? { name: rawName } : {}),
    ...(rawTicket ? { ticket: rawTicket } : {}),
    ...(videoIdx !== undefined ? { videoIdx } : {}),
    ...(frameIdx !== undefined ? { frameIdx } : {}),
  };
}

/**
 * Human-friendly filename from a URL for the title/toast: the last non-empty path
 * segment (query stripped, percent-decoded), falling back to the host, then the
 * raw string.
 */
export function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    // Decode, then neutralize any decoded path separator (an encoded %2F would
    // otherwise re-introduce a "/" and re-break the streaming filenameHint FS path).
    return seg ? decodeURIComponent(seg).replace(/[/\\]/g, "_") : u.hostname;
  } catch {
    return url;
  }
}
