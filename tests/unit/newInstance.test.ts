/**
 * Unit tests for `openNewInstance` — Cmd+N / File > New opens a FRESH app
 * instance (Welcome screen), leaving the current project untouched.
 *
 *   - Browser: a new tab via `window.open(base, "_blank")`; a blocked pop-up
 *     (null return) surfaces a warning instead of failing silently.
 *   - Desktop (Tauri): a new native `WebviewWindow` at the current origin.
 *
 * The platform layer and Tauri window API are mocked so no real runtime is
 * needed; `window.open` is stubbed per test.
 */
import { describe, it, expect, vi } from "../bun-test";

// Control the runtime without a real platform probe.
let platformIsTauri = false;
const getPlatformMock = vi.fn(async () => ({ isTauri: platformIsTauri }));
vi.mock("@/platform/index", () => ({ getPlatform: getPlatformMock }));

// Capture the pop-up-blocked warning.
const warnMock = vi.fn();
vi.mock("@/lib/notify", () => ({ toast: { warning: warnMock } }));

// Record native windows created on the Tauri path.
const createdWindows: Array<{ label: string; opts: Record<string, unknown> }> = [];
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, opts: Record<string, unknown>) {
      createdWindows.push({ label, opts });
    }
  },
}));

import { openNewInstance } from "@/lib/newInstance";

// Recorded window.open calls (captured with the types we want to assert on —
// the bun-test mock's own `.mock.calls` args are typed too loosely to index).
let openCalls: Array<{ url: string; target: unknown }> = [];

/** Replace window.open with a spy returning `ret`, recording its args. */
function stubWindowOpen(ret: Window | null) {
  Object.defineProperty(window, "open", {
    value: (url?: unknown, target?: unknown) => {
      openCalls.push({ url: String(url), target });
      return ret;
    },
    configurable: true,
    writable: true,
  });
}

describe("openNewInstance", () => {
  it("opens a new browser tab at the app root when not in Tauri", async () => {
    platformIsTauri = false;
    warnMock.mockClear();
    openCalls = [];
    stubWindowOpen({} as Window);

    await openNewInstance();

    expect(openCalls.length).toBe(1);
    expect(openCalls[0].url).toContain(location.origin);
    expect(openCalls[0].target).toBe("_blank");
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("warns when the browser blocks the pop-up (window.open returns null)", async () => {
    platformIsTauri = false;
    warnMock.mockClear();
    openCalls = [];
    stubWindowOpen(null);

    await openNewInstance();

    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("opens a new native window at the current origin in Tauri", async () => {
    platformIsTauri = true;
    createdWindows.length = 0;
    openCalls = [];
    stubWindowOpen({} as Window);

    await openNewInstance();

    expect(createdWindows.length).toBe(1);
    // Loads the current origin (keeps cross-origin isolation in the packaged
    // app), not a bare relative "/".
    expect(String(createdWindows[0].opts.url)).toContain(location.origin);
    // The desktop path must NOT fall through to a browser tab.
    expect(openCalls.length).toBe(0);
  });
});
