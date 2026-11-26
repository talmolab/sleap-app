/**
 * The analytics wire protocol: what goes over the network, and the pure
 * functions that make a value safe to send.
 *
 * Two endpoints on `analytics.sleap.ai` (talmolab/sleap-analytics-service):
 *
 *   POST /v2/events   batched events; the contract this module mirrors is
 *                     written at the top of `app/events.py` in that repo.
 *   POST /ping        the endpoint PyQt SLEAP has posted to since 2022. A
 *                     service that predates /v2/events answers 404 there, and
 *                     the desktop app then sends one of these instead, so a
 *                     launch is still counted (see `buildLegacyPing`).
 *
 * Everything here is a leaf: no stores, no DOM, no network. That is what lets
 * the privacy-relevant behavior (what a message is reduced to before it
 * leaves the machine) be unit-tested on its own.
 */

/** Envelope version understood by the service. */
export const ANALYTICS_SCHEMA = 1;

/** `product` in every batch. The service stores batches from any product. */
export const PRODUCT = "sleap-app";

/**
 * Size bounds. The service enforces the same numbers (`MAX_*` in
 * `app/events.py`); the client stays inside them so a batch is never rejected
 * or repaired on arrival.
 */
export const LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxEvents: 100,
  maxContextKeys: 64,
  maxPropsKeys: 128,
  maxString: 512,
} as const;

/** The only value types the service stores. */
export type Scalar = string | number | boolean | null;
export type Props = Record<string, Scalar>;

export interface WireEvent {
  name: string;
  /** Client clock, ms since epoch. */
  t: number;
  /** Position within the session; a gap means a batch was lost. */
  seq: number;
  props: Props;
}

export interface WireBatch {
  schema: typeof ANALYTICS_SCHEMA;
  batch_id: string;
  product: string;
  version: string;
  install_id: string;
  session_id: string;
  /** Client clock when the request was made (re-stamped on every attempt). */
  sent_at: number;
  context: Props;
  events: WireEvent[];
}

/** A property key the service will keep (it drops any other). */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** An event name the service will accept (it rejects the batch otherwise). */
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function isValidEventName(name: string): boolean {
  return EVENT_NAME_PATTERN.test(name);
}

/**
 * Reduce an arbitrary object to what the service stores: valid keys, scalar
 * values, strings no longer than the limit, at most `maxKeys` entries.
 * `undefined` is skipped so callers can pass optional fields directly.
 */
export function sanitizeProps(
  raw: Record<string, unknown> | undefined | null,
  maxKeys: number = LIMITS.maxPropsKeys,
): Props {
  const out: Props = {};
  if (!raw) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= maxKeys) break;
    if (!isValidKey(key) || value === undefined) continue;
    if (value === null || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.length > LIMITS.maxString ? value.slice(0, LIMITS.maxString) : value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) continue;
      out[key] = value;
    } else {
      continue;
    }
    kept++;
  }
  return out;
}

// ── Scrubbing free text ──────────────────────────────────────────────────────
//
// Error messages are the one place free text enters an event, and they
// routinely quote the thing that failed: a video path, a project filename, a
// URL. Those name people, labs and experiments, and none of it helps group or
// fix an error. Each is replaced by a placeholder BEFORE the text is stored or
// sent. Order matters: URLs first (they contain path-like tails), then paths,
// then bare filenames. When a rule has to guess, it guesses toward removing
// too much.

const SCRUBBERS: [RegExp, string][] = [
  // blob: and data: URLs first — a blob URL wraps another URL (blob:http://…).
  [/\b(?:blob|data):[^\s"'<>)\]]+/gi, "<url>"],
  // scheme://anything — http(s), file, tauri, asset, s3, …
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)\]]+/gi, "<url>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
  // A quoted path is taken whole, spaces included: '/Users/Jane Doe/a b.slp'.
  [/(["'`])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^"'`]*\1/g, "$1<path>$1"],
  // Windows drive paths (C:\Users\… or C:/Users/…) and UNC shares (\\server\share\…)
  [/\b[A-Za-z]:[\\/][^\s"'<>|*?]*/g, "<path>"],
  [/\\\\[^\s"'<>|*?\\]+\\[^\s"'<>|*?]*/g, "<path>"],
  // Home-relative and POSIX absolute paths with at least two segments.
  [/(^|[\s"'(=:,[])~\/[^\s"'<>)\]]*/g, "$1<path>"],
  [/(^|[\s"'(=:,[])\/(?:[^\s"'<>)\]/]+\/)+[^\s"'<>)\]]*/g, "$1<path>"],
  // An unquoted path with a space in it ("C:\Users\Jane Doe\a.mp4") is cut
  // short by the rules above, leaving its tail behind — and the tail is the
  // part with the person's name in it. Anything after a path that still has a
  // separator in it is the rest of that path. This can swallow a few innocent
  // words; erring that way is the point.
  [/<path>(?:(?: [^\s"'<>]+){0,3}? [^\s"'<>]*[\\/][^\s"'<>]*)+/g, "<path>"],
  // What is left of a path-less filename: anything ending in a data extension.
  [
    /[^\s"'<>()[\]/\\]+\.(?:pkg\.slp|slp|mp4|avi|mov|mkv|webm|mjpeg|h264|h5|hdf5|nwb|csv|json|ya?ml|png|jpe?g|tiff?|bmp|ckpt|pt|pth|onnx|zip)\b/gi,
    "<file>",
  ],
];

/** Longest scrubbed message kept. Enough to tell errors apart, no more. */
export const MAX_MESSAGE = 300;

/**
 * Remove paths, filenames, URLs and email addresses from a message and cap its
 * length. The result is safe to send and stable enough to group by.
 */
export function scrubText(text: string, maxLength: number = MAX_MESSAGE): string {
  let out = String(text);
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

/** FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A short id shared by every occurrence of "the same" error, so reports can be
 * counted and looked up. Built from the kind and the scrubbed message with
 * digits collapsed, so "frame 12 of 300" and "frame 13 of 300" group together
 * and so do the same failure on two different files.
 *
 * Deliberately NOT built from the stack: chunk filenames and minified symbol
 * names change on every release, which would split one bug across versions.
 */
export function errorFingerprint(kind: string, message: string): string {
  const normalized = scrubText(message, 2000).replace(/\d+(?:\.\d+)?/g, "#").toLowerCase();
  return fnv1a(`${kind}|${normalized}`);
}

/**
 * The top frames of a stack, reduced to `function@file:line:col` with every
 * URL and directory removed. In a production build these are bundle chunk
 * names, which is exactly what a source map needs and nothing else.
 */
export function summarizeStack(stack: string | undefined | null, maxFrames = 4): string {
  if (!stack) return "";
  const frames: string[] = [];
  for (const line of String(stack).split("\n")) {
    // V8: "    at fn (https://host/assets/index-abc.js:10:20)" / "    at https://…:10:20"
    // JavaScriptCore / SpiderMonkey: "fn@https://host/assets/index-abc.js:10:20"
    const match = /([^\s/\\()@]+\.(?:m?[jt]sx?))(?:\?[^:\s)]*)?:(\d+):(\d+)/.exec(line);
    if (!match) continue;
    const fn =
      /^\s*at\s+(?:async\s+)?([^\s(]+)\s+\(/.exec(line)?.[1] ?? /^\s*([^@\s]*)@/.exec(line)?.[1] ?? "";
    const name = /^[\w$.<>]{1,60}$/.test(fn) ? fn : "";
    frames.push(`${name}@${match[1]}:${match[2]}:${match[3]}`);
    if (frames.length >= maxFrames) break;
  }
  return frames.join(" < ").slice(0, LIMITS.maxString);
}

/**
 * Coarse size bucket for a count. Project sizes are reported as buckets, never
 * exact numbers: enough to tell a 20-frame tutorial project from a 5,000-frame
 * dataset, not enough to recognize a particular one.
 */
export function bucket(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  if (n <= 500) return "101-500";
  if (n <= 2000) return "501-2k";
  if (n <= 10000) return "2k-10k";
  return "10k+";
}

// ── The legacy /ping ─────────────────────────────────────────────────────────

/** The five keys PyQt SLEAP's `get_analytics_data()` sends. */
export interface LegacyPing {
  sleap_version: string;
  python_version: string;
  tf_version: string;
  conda_env: string;
  platform: string;
}

/** Prefix that marks a `/ping` row as coming from this app, not PyQt SLEAP. */
export const LEGACY_VERSION_PREFIX = `${PRODUCT}/`;

/**
 * A `platform.platform()`-style string, e.g. `macOS-14.5-arm64` or
 * `Windows-11-x86_64`. The reporting repo classifies the OS by substring
 * ("Windows" / "macOS" / "Linux") and reads the major version with
 * `^(Windows|macOS)-(\d+)`, so the family leads and the version follows it.
 */
export function legacyPlatform(info: {
  os: string;
  osVersion?: string | null;
  arch?: string | null;
}): string {
  const family =
    { macos: "macOS", windows: "Windows", linux: "Linux" }[info.os] ?? (info.os || "unknown");
  return [family, info.osVersion, info.arch].filter((part) => !!part).join("-");
}

/**
 * The `/ping` body for a service that has no `/v2/events` yet.
 *
 * Every field is there for a reason in talmolab/sleap-analytics-service:
 *
 *  - All FIVE keys are sent as real strings. That service logs a warning — and
 *    its runbook says to alert — when any of them is absent.
 *  - `sleap_version` carries the `sleap-app/` prefix. The dashboard's version
 *    chart extracts `^\d+\.\d+`, so a prefixed value stays out of PyQt SLEAP's
 *    adoption chart (where app 0.2 would read as an ancient SLEAP release)
 *    while still counting as a launch and a user.
 *  - `tf_version` is `"N/A"`, the value SLEAP 1.6 sends for "no TensorFlow".
 *  - `conda_env` is `""`, which is what a non-conda install sends; anything
 *    else would count this app toward the conda share.
 *  - `python_version` is the Python the app runs sleap-nn with, or `"N/A"`.
 */
export function buildLegacyPing(info: {
  version: string;
  pythonVersion?: string | null;
  platform: string;
}): LegacyPing {
  return {
    sleap_version: `${LEGACY_VERSION_PREFIX}${info.version}`,
    python_version: info.pythonVersion || "N/A",
    tf_version: "N/A",
    conda_env: "",
    platform: info.platform || "unknown",
  };
}
