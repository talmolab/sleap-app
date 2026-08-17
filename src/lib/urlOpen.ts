/**
 * Browser "Open in SLEAP" deep-link parsing.
 *
 * sleap-share's "Open in SLEAP" button navigates the browser to
 * `…/?open=<encodeURIComponent(downloadUrl)>`. `URLSearchParams.get` percent-decodes
 * once, so the single `encodeURIComponent` round-trips cleanly and the download
 * URL's own token query-suffix survives intact. See issue #217.
 */

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
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value); // throws on relative / junk
  } catch {
    return null;
  }
  // Only http(s) are safe to hand to the streaming reader from the browser.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return value;
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
    return seg ? decodeURIComponent(seg) : u.hostname;
  } catch {
    return url;
  }
}
