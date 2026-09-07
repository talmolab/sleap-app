/**
 * Tests for the Thread-C background proxy build + hot-swap orchestrator
 * (src/lib/transcode/backgroundProxySwap.ts).
 *
 * The video opens on the ORIGINAL backend immediately; this runs the proxy build
 * in the background and, when it passes the frame-exact gate AND the video is
 * still active, swaps `video.backend` to the proxy (frame-exact → seamless) and
 * closes the old backend. It must NEVER disrupt the open: any fallback/abort/
 * failure leaves the original backend in place.
 *
 * Follows the repo idiom (see resolveVideos.test.ts): plain async fakes for the
 * injected deps + closure counters for assertions, rather than mock objects.
 */

import { describe, it, expect } from "../bun-test";
import {
  runBackgroundProxySwap,
  type BackgroundProxyDeps,
} from "@/lib/transcode/backgroundProxySwap";

function fakeBackend(label: string) {
  let closed = 0;
  return {
    label,
    get closed() {
      return closed;
    },
    close() {
      closed += 1;
    },
    async getFrame() {
      return {} as unknown;
    },
  };
}

function setup(overrides: Partial<BackgroundProxyDeps> = {}) {
  const original = fakeBackend("original");
  const proxy = fakeBackend("proxy");
  const video = { backend: original } as {
    backend: { label: string; closed: number; close: () => void } | null;
  };
  const calls = { reread: 0, swapped: 0, buildEnd: 0, openProxy: 0 };
  const deps: BackgroundProxyDeps = {
    ensureProxy: async () => ({ path: "/cache/p.mp4", isProxy: true }),
    openProxyBackend: async () => {
      calls.openProxy += 1;
      return proxy as never;
    },
    isStillActive: () => true,
    triggerReread: () => {
      calls.reread += 1;
    },
    onBuildEnd: () => {
      calls.buildEnd += 1;
    },
    onSwapped: () => {
      calls.swapped += 1;
    },
    ...overrides,
  };
  return { original, proxy, video, calls, deps };
}

describe("runBackgroundProxySwap", () => {
  it("swaps to the proxy and closes the original when the build succeeds and the video is active", async () => {
    const { original, proxy, video, calls, deps } = setup();

    const outcome = await runBackgroundProxySwap(
      video as never,
      "src.mp4",
      new AbortController(),
      deps,
    );

    expect(outcome).toBe("swapped");
    expect(video.backend).toBe(proxy);
    expect(original.closed).toBe(1);
    expect(calls.reread).toBe(1);
    expect(calls.swapped).toBe(1);
    expect(calls.buildEnd).toBe(1);
  });

  it("does NOT swap when the build falls back to the original (not a proxy)", async () => {
    const { original, video, calls, deps } = setup({
      ensureProxy: async () => ({ path: "/src.mp4", isProxy: false }),
    });

    const outcome = await runBackgroundProxySwap(
      video as never,
      "src.mp4",
      new AbortController(),
      deps,
    );

    expect(outcome).toBe("not-proxy");
    expect(video.backend).toBe(original);
    expect(calls.reread).toBe(0);
    expect(calls.openProxy).toBe(0);
    expect(calls.buildEnd).toBe(1);
  });

  it("does NOT swap (and closes a just-opened proxy) when the video changed during the build", async () => {
    const { original, proxy, video, calls, deps } = setup({
      isStillActive: () => false,
    });

    const outcome = await runBackgroundProxySwap(
      video as never,
      "src.mp4",
      new AbortController(),
      deps,
    );

    expect(outcome).toBe("video-changed");
    expect(video.backend).toBe(original); // untouched
    expect(calls.reread).toBe(0);
    // Nothing leaks: if the impl opened the proxy before the active-check, it
    // closed it; if it checked before opening, it never opened one.
    if (calls.openProxy > 0) expect(proxy.closed).toBe(1);
    expect(calls.buildEnd).toBe(1);
  });

  it("does NOT swap when the build is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { original, video, calls, deps } = setup({
      ensureProxy: async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });

    const outcome = await runBackgroundProxySwap(
      video as never,
      "src.mp4",
      controller,
      deps,
    );

    expect(outcome).toBe("aborted");
    expect(video.backend).toBe(original);
    expect(calls.buildEnd).toBe(1);
  });

  it("keeps the original when the build throws a non-abort error", async () => {
    const { original, video, calls, deps } = setup({
      ensureProxy: async () => {
        throw new Error("ffmpeg exploded");
      },
    });

    const outcome = await runBackgroundProxySwap(
      video as never,
      "src.mp4",
      new AbortController(),
      deps,
    );

    expect(outcome).toBe("failed");
    expect(video.backend).toBe(original);
    expect(calls.reread).toBe(0);
    expect(calls.buildEnd).toBe(1);
  });
});
