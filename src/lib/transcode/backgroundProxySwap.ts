/**
 * Thread-C background proxy build + hot-swap (scrub-proxy v2).
 *
 * v1 blocked the video open on the first-build ffmpeg encode behind a modal
 * dialog. Instead, the open path attaches the ORIGINAL backend immediately (the
 * video appears and scrubs at once — Threads A/B make the original scrub well),
 * and this runs the proxy build in the BACKGROUND. When the build passes the
 * frame-exact gate AND the video is still the active one, it hot-swaps
 * `video.backend` to the proxy and closes the old backend. Because the proxy is
 * frame-exact (proxy frame N == source frame N), the caller just re-reads the
 * current frame — frameIdx/zoom/pan are preserved, no visible jump. (Kdenlive's
 * transparent proxy switch.)
 *
 * A proxy is an OPTIMIZATION: any fallback (not worth proxying / frame-exact gate
 * fails), abort (video closed/changed), or error MUST leave the original backend
 * untouched — it can never break the open. All I/O is injected so this is
 * unit-testable with fakes.
 */

import type { ScrubProxyResult } from "./scrubProxy.js";

/** The minimal backend surface the swap touches (decodes + frees resources). */
interface SwapBackend {
  getFrame(frameIndex: number, opts?: unknown): Promise<unknown>;
  close(): void;
}

/** The minimal Video surface the swap touches. */
interface SwapTarget {
  backend: SwapBackend | null;
}

export interface BackgroundProxyDeps {
  /**
   * Build (or cache-resolve) the proxy. Resolves `{isProxy:true}` with the proxy
   * path once it passes the frame-exact gate, or `{isProxy:false}` on any
   * fallback. Honors `signal`.
   */
  ensureProxy: (opts: {
    signal: AbortSignal;
    onStart?: (info: { durationMs?: number }) => void;
    onProgress?: (frame: number | null) => void;
  }) => Promise<ScrubProxyResult>;
  /** Open an Mp4Box backend on the (local, frame-exact) proxy path. */
  openProxyBackend: (proxyPath: string, name: string) => Promise<SwapBackend>;
  /** Whether the target video is still the one we should swap (guards close/change). */
  isStillActive: () => boolean;
  /** Make the player re-read the current frame from the freshly-swapped backend. */
  triggerReread: () => void;
  /** Fired once when the build settles (success, fallback, abort, or error). */
  onBuildEnd?: () => void;
  /** Fired after a successful hot-swap (e.g. a "faster scrubbing ready" toast). */
  onSwapped?: (name: string) => void;
}

export type BackgroundProxyOutcome =
  | "swapped"
  | "not-proxy"
  | "video-changed"
  | "aborted"
  | "failed";

/**
 * Run one background proxy build + hot-swap for `video`. See the module doc.
 * Never throws — returns an outcome; the original backend is left in place on
 * anything but `"swapped"`.
 */
export async function runBackgroundProxySwap(
  video: SwapTarget,
  name: string,
  controller: AbortController,
  deps: BackgroundProxyDeps,
): Promise<BackgroundProxyOutcome> {
  try {
    const result = await deps.ensureProxy({ signal: controller.signal });
    if (controller.signal.aborted) return "aborted";
    if (!result.isProxy) return "not-proxy"; // fallback → keep the original
    if (!deps.isStillActive()) return "video-changed";

    const proxyBackend = await deps.openProxyBackend(result.path, name);
    // Opening can take a moment; re-check before mutating so we never swap onto a
    // video the user has since closed/changed (and don't leak the opened proxy).
    if (controller.signal.aborted || !deps.isStillActive()) {
      try {
        proxyBackend.close();
      } catch {
        // ignore
      }
      return controller.signal.aborted ? "aborted" : "video-changed";
    }

    const old = video.backend;
    video.backend = proxyBackend;
    deps.triggerReread();
    deps.onSwapped?.(name);
    if (old && old !== proxyBackend) {
      try {
        old.close();
      } catch {
        // ignore — a stale in-flight read on the old backend just resolves/errors
      }
    }
    return "swapped";
  } catch (err) {
    if (
      controller.signal.aborted ||
      (err as { name?: string } | null)?.name === "AbortError"
    ) {
      return "aborted";
    }
    // Surface the REAL error — logging a bare `err` shows `{}` for a non-Error
    // throw (e.g. a Tauri IPC rejection), which hides the actual failure.
    let detail: string;
    if (err instanceof Error) {
      detail = err.stack || err.message;
    } else {
      try {
        detail = JSON.stringify(err) ?? String(err);
      } catch {
        detail = String(err);
      }
      if (detail === "{}" && err && typeof err === "object") {
        // Empty JSON but a real object → dump own props (Tauri error shapes).
        detail = Object.getOwnPropertyNames(err)
          .map((k) => `${k}=${String((err as Record<string, unknown>)[k])}`)
          .join(", ");
      }
    }
    console.warn(
      `[video] background scrub-proxy build failed for "${name}" ` +
        `[${Object.prototype.toString.call(err)}]: ${detail || "(no detail)"}`,
    );
    return "failed";
  } finally {
    deps.onBuildEnd?.();
  }
}
