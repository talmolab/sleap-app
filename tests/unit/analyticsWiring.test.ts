/**
 * The pieces around the analytics client: consent, the context sent with each
 * batch, the two transports, the leaf API the app calls, and the store
 * watchers that turn app activity into events.
 */
import { describe, it, expect, beforeEach, afterEach } from "../bun-test";
import {
  analyticsAllowedInThisBuild,
  browserAsksNotToBeTracked,
  usageDataEnabled,
  DEBUG_FLAG,
} from "@/lib/analytics/consent";
import { buildContext, parseUserAgent, type ContextInputs } from "@/lib/analytics/context";
import {
  createDesktopTransport,
  createWebTransport,
  DEFAULT_ANALYTICS_URL,
} from "@/lib/analytics/transport";
import {
  countCommand,
  countMenu,
  getAnalyticsClient,
  menuUsageKey,
  reportError,
  setAnalyticsClient,
  track,
} from "@/lib/analytics";
import type { AnalyticsClient } from "@/lib/analytics/client";
import { projectOpenedProps, runOutcome, watchErrors, watchRun } from "@/lib/analytics/instrument";
import { sanitizeProps, LIMITS } from "@/lib/analytics/protocol";

describe("consent", () => {
  it("is on by default", () => {
    expect(usageDataEnabled(null, {})).toBe(true);
  });

  it("defaults to off when the browser asks not to be tracked", () => {
    expect(browserAsksNotToBeTracked({ globalPrivacyControl: true })).toBe(true);
    expect(browserAsksNotToBeTracked({ doNotTrack: "1" })).toBe(true);
    expect(browserAsksNotToBeTracked({ doNotTrack: "0" })).toBe(false);
    expect(browserAsksNotToBeTracked({})).toBe(false);
    expect(usageDataEnabled(null, { globalPrivacyControl: true })).toBe(false);
    expect(usageDataEnabled(null, { doNotTrack: "1" })).toBe(false);
  });

  it("lets an explicit choice win in both directions", () => {
    expect(usageDataEnabled(false, {})).toBe(false);
    expect(usageDataEnabled(true, { globalPrivacyControl: true, doNotTrack: "1" })).toBe(true);
  });

  it("treats a corrupt stored value as no choice, not as consent", () => {
    for (const junk of ["false", "true", 0, 1, {}, undefined]) {
      expect(usageDataEnabled(junk as never, { doNotTrack: "1" })).toBe(false);
      expect(usageDataEnabled(junk as never, {})).toBe(true);
    }
  });

  describe("the build gate", () => {
    afterEach(() => {
      localStorage.removeItem(DEBUG_FLAG);
      Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
    });

    it("never reports from an automated browser", () => {
      Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
      expect(analyticsAllowedInThisBuild()).toBe(false);
    });

    it("can be forced on for local testing of the pipeline", () => {
      Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
      localStorage.setItem(DEBUG_FLAG, "1");
      expect(analyticsAllowedInThisBuild()).toBe(true);
    });
  });
});

describe("parseUserAgent", () => {
  const UA = {
    chromeWin:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    edgeWin:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86",
    safariMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    wkWebView: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    chromeAndroid:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    safariIpad:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  };

  it("reads the OS family and the browser family with its major version", () => {
    expect(parseUserAgent(UA.chromeWin)).toEqual({ os: "windows", osVersion: "10.0", browser: "chrome", browserVersion: "131" });
    expect(parseUserAgent(UA.edgeWin)).toMatchObject({ os: "windows", browser: "edge", browserVersion: "131" });
    expect(parseUserAgent(UA.safariMac)).toEqual({ os: "macos", osVersion: "10.15", browser: "safari", browserVersion: "18" });
    expect(parseUserAgent(UA.wkWebView)).toMatchObject({ os: "macos", browser: "webkit", browserVersion: "605" });
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({ os: "linux", osVersion: null, browser: "firefox", browserVersion: "133" });
    expect(parseUserAgent(UA.chromeAndroid)).toMatchObject({ os: "android", osVersion: "14", browser: "chrome" });
    expect(parseUserAgent(UA.safariIpad)).toMatchObject({ os: "ios", osVersion: "17", browser: "safari" });
    expect(parseUserAgent("")).toEqual({ os: "other", osVersion: null, browser: "other", browserVersion: null });
  });
});

describe("buildContext", () => {
  const inputs: ContextInputs = {
    runtime: "desktop",
    channel: "stable",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    system: { os: "macos", osVersion: "14.5", arch: "arm64" },
    language: "en-US",
    cores: 10,
    memoryGb: null,
    screenWidth: 1728,
    screenHeight: 1117,
    pixelRatio: 2,
    crossOriginIsolated: true,
    webCodecs: true,
    webGpu: false,
    environment: {
      accelerator: "mps",
      gpuCount: 1,
      gpu: null,
      sleapNn: "0.3.2",
      uv: "0.9.1",
      python: "3.12.4",
    },
  };

  it("prefers native OS facts over the frozen user-agent string", () => {
    const context = buildContext(inputs);
    expect(context).toMatchObject({
      runtime: "desktop",
      channel: "stable",
      os: "macos",
      os_version: "14.5", // not the UA's 10.15
      arch: "arm64",
      platform: "macOS-14.5-arm64",
      browser: "webkit",
      accelerator: "mps",
      sleap_nn: "0.3.2",
      python: "3.12.4",
    });
  });

  it("falls back to the user agent in a browser", () => {
    const context = buildContext({ ...inputs, runtime: "web", system: null, environment: null });
    expect(context).toMatchObject({ os: "macos", os_version: "10.15", arch: null, platform: "macOS-10.15" });
    expect(context.accelerator).toBeNull();
  });

  it("sends the language but not the region", () => {
    expect(buildContext(inputs).lang).toBe("en");
    expect(buildContext({ ...inputs, language: "pt-BR" }).lang).toBe("pt");
    expect(buildContext({ ...inputs, language: null }).lang).toBeNull();
  });

  it("is flat scalars that fit the service's context limit", () => {
    const context = buildContext(inputs);
    // Nothing is dropped by the sanitizer, so nothing here is nested or malformed.
    expect(sanitizeProps(context, LIMITS.maxContextKeys)).toEqual(context as never);
    expect(Object.keys(context).length).toBeLessThan(LIMITS.maxContextKeys - 4);
  });

  it("carries nothing that names a machine or a person", () => {
    const serialized = JSON.stringify(buildContext(inputs));
    expect(serialized).not.toContain("Mozilla"); // no raw user-agent string
    for (const key of Object.keys(buildContext(inputs))) {
      expect(key).not.toMatch(/host|user|name|path|ip|timezone|tz/);
    }
  });
});

describe("the web transport", () => {
  it("posts JSON with no credentials or referrer and resolves the status", async () => {
    const calls: [string, RequestInit][] = [];
    const transport = createWebTransport("https://analytics.example", async (url, init) => {
      calls.push([url, init]);
      return { status: 200 };
    });

    expect(await transport.post("/v2/events", '{"a":1}', { keepalive: true })).toBe(200);
    const [url, init] = calls[0];
    expect(url).toBe("https://analytics.example/v2/events");
    expect(init).toMatchObject({
      method: "POST",
      body: '{"a":1}',
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
    });
    // The service requires application/json: it is what forces the CORS preflight.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("resolves 0, never rejects, when the request fails", async () => {
    const transport = createWebTransport("https://analytics.example", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await transport.post("/v2/events", "{}")).toBe(0);
  });

  it("cannot send the legacy ping, and points at the production service by default", () => {
    expect(createWebTransport().canLegacyPing).toBe(false);
    expect(DEFAULT_ANALYTICS_URL).toBe("https://analytics.sleap.ai");
  });
});

describe("the desktop transport", () => {
  it("hands native code a path and a body, never a URL", async () => {
    const calls: unknown[][] = [];
    const transport = createDesktopTransport(async (...args) => {
      calls.push(args);
      return 200;
    }, "plugin:sleap|analytics_post");
    expect(transport.canLegacyPing).toBe(true);
    expect(await transport.post("/ping", '{"a":1}')).toBe(200);
    expect(calls).toEqual([["plugin:sleap|analytics_post", { path: "/ping", body: '{"a":1}' }]]);
  });

  it("resolves 0 when the command fails or answers nonsense", async () => {
    const failing = createDesktopTransport(async () => {
      throw new Error("offline");
    }, "cmd");
    expect(await failing.post("/v2/events", "{}")).toBe(0);
    const odd = createDesktopTransport(async () => "200", "cmd");
    expect(await odd.post("/v2/events", "{}")).toBe(0);
  });
});

describe("the leaf API", () => {
  let recorded: { counts: string[]; errors: Record<string, unknown>[]; events: unknown[][] };

  beforeEach(() => {
    recorded = { counts: [], errors: [], events: [] };
    setAnalyticsClient({
      count: (key: string) => recorded.counts.push(key),
      trackError: (error: Record<string, unknown>) => recorded.errors.push(error),
      track: (...args: unknown[]) => recorded.events.push(args),
    } as unknown as AnalyticsClient);
  });
  afterEach(() => setAnalyticsClient(null));

  it("is a silent no-op until a client is installed", () => {
    setAnalyticsClient(null);
    expect(getAnalyticsClient()).toBeNull();
    countMenu("file.save");
    countCommand("AddInstance");
    track("inference_started", {});
    reportError("uncaught", "boom");
    expect(recorded).toEqual({ counts: [], errors: [], events: [] });
  });

  it("drops the index from data-driven menu ids", () => {
    expect(menuUsageKey("file.save")).toBe("m:file.save");
    expect(menuUsageKey("tracks.setTrack.3")).toBe("m:tracks.setTrack");
    expect(menuUsageKey("file.replaceVideo.12")).toBe("m:file.replaceVideo");
    expect(menuUsageKey("view.panels.videos")).toBe("m:view.panels.videos");
  });

  it("counts menus and commands under separate prefixes", () => {
    countMenu("tracks.delete.2");
    countCommand("AddInstance");
    expect(recorded.counts).toEqual(["m:tracks.delete", "c:AddInstance"]);
  });

  it("scrubs an error before it reaches the client, and says what ran before it", () => {
    countCommand("OpenProject");
    reportError(
      "uncaught",
      "Failed to open /Users/jane/lab/mouse.slp",
      "Error\n    at open (https://app.sleap.ai/assets/index-a1.js:5:10)",
    );
    expect(recorded.errors).toHaveLength(1);
    const error = recorded.errors[0];
    expect(error).toMatchObject({
      kind: "uncaught",
      message: "Failed to open <path>",
      stack: "open@index-a1.js:5:10",
      after: "c:OpenProject",
    });
    expect(error.fp).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(error)).not.toContain("jane");
  });

  it("never throws into the caller, whatever the client does", () => {
    setAnalyticsClient({
      count: () => {
        throw new Error("x");
      },
      track: () => {
        throw new Error("x");
      },
      trackError: () => {
        throw new Error("x");
      },
    } as unknown as AnalyticsClient);
    expect(() => {
      countMenu("file.save");
      countCommand("AddInstance");
      track("inference_started", {});
      reportError("render", { toString: () => "odd" }, 42);
    }).not.toThrow();
  });
});

describe("watchRun", () => {
  function fakeStore(status: string) {
    let state = { status, extra: 0 };
    const listeners = new Set<(s: typeof state, p: typeof state) => void>();
    return {
      getState: () => state,
      subscribe: (listener: (s: typeof state, p: typeof state) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set: (patch: Partial<typeof state>) => {
        const previous = state;
        state = { ...state, ...patch };
        for (const listener of listeners) listener(state, previous);
      },
    };
  }

  it("reports a start, then the outcome with its duration", () => {
    const store = fakeStore("idle");
    let now = 1_000;
    const log: unknown[] = [];
    watchRun(store, () => now, () => log.push("start"), (_s, outcome, seconds) => log.push([outcome, seconds]));

    store.set({ status: "running" });
    store.set({ extra: 1 }); // unrelated updates (progress ticks) do nothing
    store.set({ extra: 2 });
    now += 90_400;
    store.set({ status: "completed" });
    expect(log).toEqual(["start", ["completed", 90]]);

    store.set({ status: "idle" }); // leaving a terminal state is not a finish
    expect(log).toHaveLength(2);
  });

  it("maps every terminal status to an outcome", () => {
    expect(["completed", "error", "stopped", "cancelled", "idle"].map(runOutcome)).toEqual([
      "completed", "error", "stopped", "cancelled", "cancelled",
    ]);
  });

  it("stops watching when unsubscribed", () => {
    const store = fakeStore("idle");
    const log: string[] = [];
    const stop = watchRun(store, Date.now, () => log.push("start"), () => log.push("finish"));
    stop();
    store.set({ status: "running" });
    expect(log).toEqual([]);
  });
});

describe("projectOpenedProps", () => {
  it("reports sizes as buckets and never an exact count", () => {
    const props = projectOpenedProps(
      { videoCount: 3, skeletonNodeCount: 13, userLabeledFrameCount: 412, predictedInstanceCount: 18250, trackCount: 2 },
      "predictions",
    );
    expect(props).toEqual({
      stage: "predictions",
      videos: "2-5",
      labeled_frames: "101-500",
      predicted_instances: "10k+",
      tracks: "2-5",
      skeleton_nodes: "6-20",
    });
    expect(JSON.stringify(props)).not.toMatch(/412|18250/);
  });
});

describe("watchErrors", () => {
  let errors: Record<string, unknown>[];
  let stop: () => void;

  beforeEach(() => {
    errors = [];
    setAnalyticsClient({ trackError: (e: Record<string, unknown>) => errors.push(e) } as unknown as AnalyticsClient);
    stop = watchErrors(window);
  });
  afterEach(() => {
    stop();
    setAnalyticsClient(null);
  });

  it("reports uncaught errors and unhandled rejections", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "x is not a function", error: new Error("x") }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("load failed for /Users/jane/a.slp");
    window.dispatchEvent(rejection);

    expect(errors.map((e) => e.kind)).toEqual(["uncaught", "unhandledrejection"]);
    expect(errors[1].message).toBe("load failed for <path>");
  });

  it("ignores browser noise that says nothing about the app", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(errors).toEqual([]);
  });

  it("stops reporting once removed", () => {
    stop();
    window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
    expect(errors).toEqual([]);
  });
});
