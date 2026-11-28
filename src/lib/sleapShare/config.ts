/**
 * SLEAP Share host configuration and URL / shortcode parsing.
 */

export const DEFAULT_SLEAP_SHARE_URL = "https://slp.sh";
const BASE_URL_STORAGE_KEY = "sleap-share:base-url";
const SHORTCODE_RE = /^[a-zA-Z0-9]{6}$/;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Validate a SLEAP Share base URL override (https anywhere, or http on loopback). */
export function sanitizeShareBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return u.origin;
    return null;
  } catch {
    return null;
  }
}

/** Resolve the active SLEAP Share base URL (storage override -> VITE env -> slp.sh). */
export function getSleapShareBaseUrl(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = sanitizeShareBaseUrl(localStorage.getItem(BASE_URL_STORAGE_KEY));
      if (stored) return stored;
    }
  } catch {
    /* ignore storage errors */
  }
  const envUrl = sanitizeShareBaseUrl(
    (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_SLEAP_SHARE_URL
  );
  return envUrl ?? DEFAULT_SLEAP_SHARE_URL;
}

export function setSleapShareBaseUrlOverride(url: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    const clean = sanitizeShareBaseUrl(url);
    if (clean && clean !== DEFAULT_SLEAP_SHARE_URL) {
      localStorage.setItem(BASE_URL_STORAGE_KEY, clean);
    } else {
      localStorage.removeItem(BASE_URL_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export interface DetectedShareDataset {
  origin: string;
  shortcode: string;
  member: string;
}

function isRecognizedShareOrigin(origin: string, configuredBaseUrl: string): boolean {
  if (origin === configuredBaseUrl) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "slp.sh" || u.hostname.endsWith(".slp.sh")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect whether a URL points to a SLEAP Share dataset (landing page or member
 * file) on `slp.sh`, `*.slp.sh`, or the configured share origin.
 */
export function detectSleapShareUrl(
  url: string,
  configuredBaseUrl = getSleapShareBaseUrl()
): DetectedShareDataset | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isRecognizedShareOrigin(parsed.origin, configuredBaseUrl)) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 1 && SHORTCODE_RE.test(segments[0])) {
    return { origin: parsed.origin, shortcode: segments[0], member: "labels.slp" };
  }
  if (segments.length === 2 && SHORTCODE_RE.test(segments[0])) {
    return {
      origin: parsed.origin,
      shortcode: segments[0],
      member: decodeURIComponent(segments[1]),
    };
  }
  return null;
}

export type ParsedOpenInput =
  | {
      kind: "share";
      origin: string;
      shortcode: string;
      member: string;
      slpUrl: string;
    }
  | {
      kind: "url";
      slpUrl: string;
    };

/**
 * Parse free-form input from the "Open from SLEAP Share / URL" dialog:
 *  - 6-char shortcode (`aBcDeF`)
 *  - `slp.sh/aBcDeF` (with or without `https://`)
 *  - `https://staging.slp.sh/aBcDeF/val.slp`
 *  - Any direct `http(s)://...` `.slp` URL
 */
export function parseShareInput(
  raw: string,
  defaultBaseUrl = getSleapShareBaseUrl()
): ParsedOpenInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (SHORTCODE_RE.test(trimmed)) {
    const origin = defaultBaseUrl.replace(/\/+$/, "");
    return {
      kind: "share",
      origin,
      shortcode: trimmed,
      member: "labels.slp",
      slpUrl: `${origin}/${trimmed}/labels.slp`,
    };
  }

  // Handle schemeless `slp.sh/abc123` or `staging.slp.sh/abc123/labels.slp`
  const withScheme =
    /^(?:[a-z0-9-]+\.)*slp\.sh\//i.test(trimmed) ? `https://${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const detected = detectSleapShareUrl(parsed.toString(), defaultBaseUrl);
  if (detected) {
    return {
      kind: "share",
      origin: detected.origin,
      shortcode: detected.shortcode,
      member: detected.member,
      slpUrl: `${detected.origin}/${detected.shortcode}/${encodeURIComponent(detected.member)}`,
    };
  }

  return { kind: "url", slpUrl: parsed.toString() };
}

/** Human-readable binary byte size (e.g. "42.3 MB", "1.4 GB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const decimals = idx === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[idx]}`;
}
