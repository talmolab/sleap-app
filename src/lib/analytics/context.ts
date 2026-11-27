/**
 * The `context` sent with every batch: the build and the machine, as flat
 * scalars. It is what turns "this error happened" into "this error happens on
 * Windows with no GPU on 0.2.1", which is most of what support needs.
 *
 * `buildContext` is pure and unit-tested. `readContextInputs` is the thin live
 * gatherer; it only reads values the browser or the stores already hold.
 *
 * Nothing here identifies a person: no computer name, user name, home
 * directory, IP address, time zone or full user-agent string. The install id
 * travels in the batch envelope, not here.
 */

import { legacyPlatform } from "./protocol";

/** OS facts from native code (`system_info`); absent in a browser. */
export interface SystemInfo {
  os: string;
  osVersion: string | null;
  arch: string | null;
}

export interface ParsedUserAgent {
  os: string;
  osVersion: string | null;
  browser: string;
  browserVersion: string | null;
}

const firstMatch = (ua: string, pattern: RegExp): string | null => pattern.exec(ua)?.[1] ?? null;

/**
 * The OS family and browser family from a user-agent string. Only the major
 * browser version is kept. The full string is never sent: it is long, and
 * between its many tokens it can single out a machine.
 */
export function parseUserAgent(ua: string): ParsedUserAgent {
  let os = "other";
  let osVersion: string | null = null;
  if (/Windows NT/.test(ua)) {
    os = "windows";
    // "NT 10.0" covers both Windows 10 and 11; the WebView cannot tell them
    // apart from this string. Desktop builds get the real version natively.
    osVersion = firstMatch(ua, /Windows NT (\d+(?:\.\d+)?)/);
  } else if (/Android/.test(ua)) {
    os = "android";
    osVersion = firstMatch(ua, /Android (\d+)/);
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    os = "ios";
    osVersion = firstMatch(ua, /OS (\d+)[_.]/);
  } else if (/CrOS/.test(ua)) {
    os = "chromeos";
  } else if (/Mac OS X/.test(ua)) {
    os = "macos";
    // Frozen at 10_15_7 by every current browser, so it says little.
    osVersion = firstMatch(ua, /Mac OS X (\d+[_.]\d+)/)?.replace("_", ".") ?? null;
  } else if (/Linux/.test(ua)) {
    os = "linux";
  }

  let browser = "other";
  let browserVersion: string | null = null;
  const families: [string, RegExp][] = [
    ["edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["firefox", /Firefox\/(\d+)/],
    ["chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["safari", /Version\/(\d+)[.\d]* .*Safari\//],
    // A WebKit WebView (WKWebView, WebKitGTK) has no Version/ or Safari/ token.
    ["webkit", /AppleWebKit\/(\d+)/],
  ];
  for (const [name, pattern] of families) {
    const version = firstMatch(ua, pattern);
    if (version) {
      browser = name;
      browserVersion = version;
      break;
    }
  }
  return { os, osVersion, browser, browserVersion };
}

/** What the installed sleap-nn environment looks like, where there is one. */
export interface EnvironmentFacts {
  accelerator: string | null;
  gpuCount: number | null;
  /** The first GPU's model name, e.g. "NVIDIA RTX 4090 (23.6 GB)". */
  gpu: string | null;
  sleapNn: string | null;
  uv: string | null;
  python: string | null;
}

export interface ContextInputs {
  runtime: "desktop" | "web";
  /** `stable` / `latest` / `dev` / `main` / `pinned` / `local`. */
  channel: string;
  userAgent: string;
  system: SystemInfo | null;
  language: string | null;
  cores: number | null;
  memoryGb: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  pixelRatio: number | null;
  crossOriginIsolated: boolean | null;
  webCodecs: boolean;
  webGpu: boolean;
  environment: EnvironmentFacts | null;
}

export function buildContext(inputs: ContextInputs): Record<string, unknown> {
  const ua = parseUserAgent(inputs.userAgent);
  const os = inputs.system?.os ?? ua.os;
  const osVersion = inputs.system?.osVersion ?? ua.osVersion;
  const arch = inputs.system?.arch ?? null;
  const env = inputs.environment;
  return {
    runtime: inputs.runtime,
    channel: inputs.channel,
    os,
    os_version: osVersion,
    arch,
    // The same string the legacy /ping sends, so a v2 session can be compared
    // with PyQt SLEAP's platform field.
    platform: legacyPlatform({ os, osVersion, arch }),
    browser: ua.browser,
    browser_version: ua.browserVersion,
    // Language only ("en"), not the region: enough to prioritize translation.
    lang: inputs.language?.split("-")[0]?.toLowerCase() || null,
    cores: inputs.cores,
    memory_gb: inputs.memoryGb,
    screen_w: inputs.screenWidth,
    screen_h: inputs.screenHeight,
    dpr: inputs.pixelRatio,
    // The three capabilities whose absence explains most "it doesn't work
    // here" reports: SharedArrayBuffer (large packages), WebCodecs (video
    // decoding) and WebGPU.
    isolated: inputs.crossOriginIsolated,
    webcodecs: inputs.webCodecs,
    webgpu: inputs.webGpu,
    accelerator: env?.accelerator ?? null,
    gpu_count: env?.gpuCount ?? null,
    gpu: env?.gpu ?? null,
    sleap_nn: env?.sleapNn ?? null,
    uv: env?.uv ?? null,
    python: env?.python ?? null,
  };
}

/** Everything `buildContext` needs that the browser itself can answer. */
export function readBrowserInputs(): Pick<
  ContextInputs,
  | "userAgent"
  | "language"
  | "cores"
  | "memoryGb"
  | "screenWidth"
  | "screenHeight"
  | "pixelRatio"
  | "crossOriginIsolated"
  | "webCodecs"
  | "webGpu"
> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const win = typeof window !== "undefined" ? window : undefined;
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    userAgent: nav?.userAgent ?? "",
    language: nav?.language ?? null,
    cores: number(nav?.hardwareConcurrency),
    memoryGb: number((nav as { deviceMemory?: number } | undefined)?.deviceMemory),
    screenWidth: number(win?.screen?.width),
    screenHeight: number(win?.screen?.height),
    pixelRatio: number(win?.devicePixelRatio),
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === "boolean" ? globalThis.crossOriginIsolated : null,
    webCodecs: typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== "undefined",
    webGpu: !!(nav as { gpu?: unknown } | undefined)?.gpu,
  };
}
