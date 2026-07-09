/**
 * Startup WebCodecs feature-probe.
 *
 * Standalone video decode in sleap-io.js (the Mp4Box and MediaBunny backends)
 * hard-requires the WebCodecs `VideoDecoder` API. When it is missing, those
 * backends throw and the video renders as blank frames with only a generic
 * per-file toast — there is no up-front signal that the *environment* can't
 * decode video at all.
 *
 * The most common place this bites is the **Linux desktop build**: Tauri uses
 * the OS WebView, which on Linux is WebKitGTK, and WebKitGTK frequently ships
 * with WebCodecs disabled or partial. (Windows = WebView2/Chromium and macOS =
 * WKWebView both ship WebCodecs, so this is rare there.) Embedded-image
 * `pkg.slp` projects and Norpix `.seq` files don't use WebCodecs and keep
 * working regardless.
 *
 * This module is split into a pure decision function (`probeWebCodecs`, unit
 * tested) and a thin runtime wrapper (`runWebCodecsProbe`) that reads the real
 * `window`/`navigator` and surfaces a one-time warning toast.
 */

export interface WebCodecsEnv {
  /** Whether `window.VideoDecoder` exists (WebCodecs available). */
  hasVideoDecoder: boolean;
  /** Whether running inside the Tauri desktop shell. */
  isTauri: boolean;
  /** `navigator.userAgent`, used to distinguish a Linux/WebKitGTK WebView. */
  userAgent: string;
}

export interface WebCodecsProbeResult {
  /** True when WebCodecs (`VideoDecoder`) is available. */
  supported: boolean;
  /** Short warning title; only set when `supported` is false. */
  title?: string;
  /** Longer, platform-aware explanation; only set when `supported` is false. */
  description?: string;
}

/**
 * Decide whether WebCodecs is available and, if not, what to tell the user.
 * Pure: takes a snapshot of the environment and returns a result.
 */
export function probeWebCodecs(env: WebCodecsEnv): WebCodecsProbeResult {
  if (env.hasVideoDecoder) {
    return { supported: true };
  }

  const isLinux = /Linux/i.test(env.userAgent);

  if (env.isTauri && isLinux) {
    return {
      supported: false,
      title: "Video decoding unavailable on this system",
      description:
        "This Linux desktop build uses the WebKitGTK WebView, which on this " +
        "machine lacks the WebCodecs API needed to decode MP4/WebM/MKV video " +
        "— those will appear as blank frames. Embedded-image (pkg.slp) " +
        "projects and Norpix .seq files are unaffected.",
    };
  }

  return {
    supported: false,
    title: "Video decoding unavailable in this browser",
    description:
      "This browser lacks the WebCodecs API needed to decode MP4/WebM/MKV " +
      "video, so those will appear as blank frames. Try a recent version of " +
      "Chrome, Edge, or Safari. Embedded-image (pkg.slp) projects and Norpix " +
      ".seq files are unaffected.",
  };
}

/** Read the live environment for the probe. Exposed for the runtime wrapper. */
export function readWebCodecsEnv(): WebCodecsEnv {
  return {
    hasVideoDecoder:
      typeof window !== "undefined" && "VideoDecoder" in window,
    // Inlined to avoid importing the platform layer (and its Tauri deps) here.
    isTauri:
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window),
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent : "",
  };
}
