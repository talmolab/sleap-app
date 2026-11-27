/**
 * Starts usage analytics for the main app window. Called once from main.tsx.
 *
 * This is the only file that knows about everything at once: the stores, the
 * two transports, the first-run notice and the timers. It wires them into an
 * `AnalyticsClient` and installs it behind the leaf API in ./index.ts.
 *
 * It does nothing at all in a build that must not report (a dev server, an
 * automated browser — see `analyticsAllowedInThisBuild`), and nothing is sent
 * or even stored until the first-run notice has been seen.
 */

import { useAppStore } from "@/stores/appStore";
import { APP_VERSION } from "@/lib/version";
import { isTauri } from "@/lib/platform";
import { sleapCmd } from "@/lib/sleapPlugin";
import { resolveDocsVersion, getDocsUrl } from "@/lib/docsUrl";
import {
  diagnosticsReady,
  getPriorCrashInfo,
} from "@/lib/diagnostics";
import { getInstallId, getSessionId } from "@/lib/diagnostics/sessionLog";
import { AnalyticsClient, type Transport } from "./client";
import {
  analyticsAllowedInThisBuild,
  analyticsDebugEnabled,
  usageDataEnabled,
} from "./consent";
import {
  buildContext,
  readBrowserInputs,
  type EnvironmentFacts,
  type SystemInfo,
} from "./context";
import { setAnalyticsClient, setQuitFlusher, track } from "./index";
import { watchErrors, watchStores } from "./instrument";
import { buildLegacyPing, isValidId } from "./protocol";
import { createDesktopTransport, createWebTransport } from "./transport";

/** How often a window with something to report sends it. */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Marks that this install has reported before, so `first_run` is true once. */
const SEEN_KEY = "sleap.analytics.seen";
/** How long the first-run notice stays up if it is not acted on. */
const NOTICE_DURATION_MS = 30_000;

/** The docs page that explains what is shared, for the notice and the Help menu. */
export function usageDataDocsUrl(): string {
  return `${getDocsUrl()}usage-data/`;
}

/** The channel this build is on, in the vocabulary of the `context.channel` field. */
function resolveChannel(): string {
  if (import.meta.env?.DEV === true) return "local";
  const version = resolveDocsVersion();
  // A permanent release path (app.sleap.ai/v0.2.0/) pins its own docs folder.
  return /^v\d/.test(version) ? "pinned" : version;
}

function safeUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** OS name, version and CPU architecture, from wherever this runtime can get them. */
async function readSystemInfo(): Promise<SystemInfo | null> {
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<SystemInfo>(sleapCmd("system_info"));
    } catch {
      return null;
    }
  }
  // Chromium only: the user-agent string no longer says which Windows or which
  // CPU, but the browser will answer when asked.
  try {
    const uaData = (
      navigator as unknown as {
        userAgentData?: {
          platform?: string;
          getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>;
        };
      }
    ).userAgentData;
    if (!uaData?.getHighEntropyValues) return null;
    const hints = await uaData.getHighEntropyValues(["architecture", "bitness", "platformVersion"]);
    const os = { Windows: "windows", macOS: "macos", Linux: "linux" }[uaData.platform ?? ""];
    if (!os) return null;
    const major = Number.parseInt(hints.platformVersion ?? "", 10);
    const osVersion =
      os === "windows"
        ? Number.isFinite(major)
          ? major >= 13
            ? "11"
            : "10"
          : null
        : hints.platformVersion || null;
    const arch =
      hints.architecture === "arm"
        ? "arm64"
        : hints.architecture === "x86" && hints.bitness === "64"
          ? "x86_64"
          : hints.architecture || null;
    return { os, osVersion, arch };
  } catch {
    return null;
  }
}

/** What the Environment panel already knows about the local sleap-nn install. */
async function readEnvironmentFacts(): Promise<() => EnvironmentFacts | null> {
  if (!isTauri) return () => null;
  const { useEnvironmentStore } = await import("@/stores/environmentStore");
  return () => {
    const env = useEnvironmentStore.getState();
    return {
      accelerator: env.accelerator?.accelerator ?? null,
      gpuCount: env.accelerator?.gpuCount ?? null,
      gpu: env.accelerator?.gpus?.[0] ?? null,
      sleapNn:
        env.tools.find((tool) => tool.name === "sleap-nn")?.version ??
        env.pythonCheck?.sleapNnVersion ??
        null,
      uv: env.uv?.version ?? null,
      python: env.pythonCheck?.version ?? null,
    };
  };
}

async function createTransport(): Promise<Transport> {
  if (!isTauri) return createWebTransport();
  const { invoke } = await import("@tauri-apps/api/core");
  return createDesktopTransport(invoke, sleapCmd("analytics_post"));
}

const NOTICE_TOAST_ID = "usage-data-notice";

/** Whether this is the primary (cold-launch) window on desktop; always true on web. */
async function detectPrimaryWindow(): Promise<boolean> {
  if (!isTauri) return true;
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().label === "main";
  } catch {
    return true;
  }
}

/**
 * Show the one-time notice. It marks itself seen when it closes, however it
 * closes: dismissed, timed out, or either of its two choices taken.
 */
export async function showFirstRunNotice(onSeen: () => void): Promise<void> {
  const [{ toast }, { openExternal }, { createElement, Fragment }] = await Promise.all([
    import("@/lib/notify"),
    import("@/lib/menu/menuActions"),
    import("react"),
  ]);
  const id = NOTICE_TOAST_ID;
  toast.info("Help improve SLEAP", {
    id,
    // Render the button row beneath the text (and suppress notify.tsx's default
    // CopyAction via an empty Fragment) so the explanation gets the full toast
    // width and "Make SLEAP better" stands out as the primary orange action.
    action: createElement(Fragment),
    description: createElement(
      "div",
      { className: "flex flex-col gap-2.5 pt-0.5" },
      createElement(
        "span",
        null,
        "SLEAP shares anonymous usage data and error reports (tied to a random ID — " +
          "never your videos, labels, or file names). ",
        createElement(
          "button",
          {
            type: "button",
            className: "underline hover:text-foreground",
            onClick: () => {
              void openExternal(usageDataDocsUrl());
            },
          },
          "Learn more",
        ),
      ),
      createElement(
        "div",
        { className: "flex items-center gap-2" },
        createElement(
          "button",
          {
            type: "button",
            className:
              "inline-flex items-center justify-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors",
            onClick: () => {
              useAppStore.getState().set("shareUsageData", true);
              onSeen();
              toast.dismiss(id);
            },
          },
          "Make SLEAP better",
        ),
        createElement(
          "button",
          {
            type: "button",
            className:
              "inline-flex items-center justify-center rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors",
            onClick: () => {
              useAppStore.getState().set("shareUsageData", false);
              onSeen();
              toast.dismiss(id);
            },
          },
          "Turn off",
        ),
      ),
    ),
    duration: NOTICE_DURATION_MS,
    onDismiss: onSeen,
    onAutoClose: onSeen,
  });
}

let started = false;

/** Best-effort. Never throws; safe to call once at boot without awaiting. */
export async function initAnalytics(): Promise<void> {
  if (started) return;
  started = true;
  try {
    if (!analyticsAllowedInThisBuild()) return;

    // The install id, session id and prior-crash flag all come from diagnostics.
    await diagnosticsReady;
    const storage = safeStorage();
    const debug = analyticsDebugEnabled();
    const bootedAt = Date.now();

    const [transport, system, environment, primaryWindow] = await Promise.all([
      createTransport(),
      readSystemInfo(),
      readEnvironmentFacts(),
      detectPrimaryWindow(),
    ]);
    const browser = readBrowserInputs();
    const channel = resolveChannel();
    const getContext = () =>
      buildContext({
        ...browser,
        runtime: isTauri ? "desktop" : "web",
        channel,
        system,
        environment: environment(),
      });

    // `getInstallId()` returns "unknown" (7 chars) when localStorage throws, which
    // would fail the service's 8-char IdStr check with permanent 422s. Fall back to
    // an ephemeral valid UUID in that case.
    const rawInstallId = getInstallId();
    const installId = isValidId(rawInstallId) ? rawInstallId : safeUuid();
    const rawSessionId = getSessionId();
    const sessionId = isValidId(rawSessionId) ? rawSessionId : safeUuid();

    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const client = new AnalyticsClient({
      transport,
      storage,
      version: APP_VERSION,
      installId,
      sessionId,
      now: Date.now,
      uuid: safeUuid,
      isEnabled: () => usageDataEnabled(useAppStore.getState().shareUsageData),
      canSend: () => useAppStore.getState().usageDataNoticeSeen,
      getContext,
      getLegacyPing: () =>
        buildLegacyPing({
          version: APP_VERSION,
          pythonVersion: environment()?.python,
          platform: String(getContext().platform ?? ""),
        }),
      requestFlush: (delayMs) => {
        if (flushTimer) return; // one is already on its way
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void client.flush();
        }, delayMs);
      },
      log: debug ? (message, detail) => console.debug("[analytics]", message, detail) : undefined,
    });
    setAnalyticsClient(client);

    // ── What gets reported ──────────────────────────────────────────────────
    // Read `firstRun` now without writing to localStorage yet: nothing is saved
    // to disk until the first-run notice has been seen and sharing is enabled.
    let firstRun = false;
    try {
      firstRun = storage != null && storage.getItem(SEEN_KEY) == null;
    } catch {
      /* without storage every launch looks like a first run; report it as not */
    }
    const markSeenOnDisk = () => {
      try {
        if (
          storage &&
          usageDataEnabled(useAppStore.getState().shareUsageData) &&
          useAppStore.getState().usageDataNoticeSeen
        ) {
          storage.setItem(SEEN_KEY, "1");
        }
      } catch {
        /* ignore */
      }
    };

    track("session_start", {
      first_run: firstRun,
      prior_crash: getPriorCrashInfo() != null,
      primary_window: primaryWindow,
    });
    watchErrors();
    void watchStores();

    // ── When it gets sent ───────────────────────────────────────────────────
    // Visible time, so a window left open overnight does not look like an
    // eight-hour working session.
    let activeMs = 0;
    let visibleSince: number | null = document.visibilityState === "visible" ? Date.now() : null;
    const settleActive = () => {
      if (visibleSince != null) {
        activeMs += Date.now() - visibleSince;
        visibleSince = document.visibilityState === "visible" ? Date.now() : null;
      } else if (document.visibilityState === "visible") {
        visibleSince = Date.now();
      }
    };

    // A heartbeat goes out only alongside something else. An idle window
    // therefore sends nothing at all, and the last heartbeat received marks
    // the end of the session's actual use.
    const sendIfAnything = (keepalive: boolean) => {
      settleActive();
      if (!client.hasPending()) return;
      track("heartbeat", {
        uptime_s: Math.round((Date.now() - bootedAt) / 1000),
        active_s: Math.round(activeMs / 1000),
      });
      void client.flush({ keepalive });
    };

    // Bounded clean-quit flush for desktop (`quit.ts` awaits this before exit/destroy).
    setQuitFlusher(async (timeoutMs) => {
      settleActive();
      if (client.hasPending()) {
        track("heartbeat", {
          uptime_s: Math.round((Date.now() - bootedAt) / 1000),
          active_s: Math.round(activeMs / 1000),
        });
      }
      await Promise.race([
        client.flush({ keepalive: true }),
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    });

    setInterval(() => sendIfAnything(false), FLUSH_INTERVAL_MS);
    // The last chance before a tab closes or the app quits. `flush()` seals
    // synchronously up front, so if the request does not complete in time the
    // batch survives in storage for the next launch.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") sendIfAnything(true);
      else settleActive();
    });
    window.addEventListener("pagehide", () => sendIfAnything(true));

    // ── Consent ─────────────────────────────────────────────────────────────
    const dismissNoticeIfOpen = () => {
      void import("@/lib/notify")
        .then(({ toast }) => toast.dismiss(NOTICE_TOAST_ID))
        .catch(() => {});
    };
    const markNoticeSeen = () => {
      if (useAppStore.getState().usageDataNoticeSeen) return;
      useAppStore.getState().set("usageDataNoticeSeen", true);
      markSeenOnDisk();
      void client.flush();
    };
    useAppStore.subscribe((state, previous) => {
      if (
        state.shareUsageData === previous.shareUsageData &&
        state.usageDataNoticeSeen === previous.usageDataNoticeSeen
      ) {
        return;
      }
      if (state.usageDataNoticeSeen && !previous.usageDataNoticeSeen) {
        dismissNoticeIfOpen();
        markSeenOnDisk();
      }
      if (state.shareUsageData !== previous.shareUsageData) {
        // Turned off: forget everything held and stored, immediately.
        if (!usageDataEnabled(state.shareUsageData)) {
          dismissNoticeIfOpen();
          client.discardAll();
        } else {
          markSeenOnDisk();
        }
      }
    });

    const { shareUsageData, usageDataNoticeSeen } = useAppStore.getState();
    if (usageDataEnabled(shareUsageData) && !usageDataNoticeSeen) {
      // Give the app shell (and its toaster) a moment to mount, then re-check
      // consent in case the user already toggled Help ▸ Share Usage Data.
      setTimeout(() => {
        const cur = useAppStore.getState();
        if (usageDataEnabled(cur.shareUsageData) && !cur.usageDataNoticeSeen) {
          void showFirstRunNotice(markNoticeSeen);
        }
      }, 1_500);
    } else {
      markSeenOnDisk();
      // Deliver anything a previous session sealed but could not send.
      void client.flush();
    }
  } catch (error) {
    console.warn("[analytics] init failed:", error);
  }
}
