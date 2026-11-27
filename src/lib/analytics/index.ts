/**
 * Usage analytics — the small API the rest of the app calls.
 *
 * This file is deliberately a leaf: it imports no stores and no platform code,
 * so the command system, the menus and the error boundary can call it without
 * creating an import cycle. Everything here is a silent no-op until
 * `initAnalytics()` (lib/analytics/init.ts, called once from main.tsx) installs
 * a client — which is why unit tests, the viz window and dev builds never send
 * anything: nothing installs one there.
 *
 * What is collected, and what never is, is defined in ./events.ts and
 * explained to users in docs/usage-data.md. How it gets to the service is in
 * ./client.ts. The map of the whole system is docs/.internal/analytics.md.
 *
 * None of these functions can throw: instrumentation must never be the reason
 * a command fails.
 */

import type { AnalyticsClient } from "./client";
import type { AnalyticsEventName, AnalyticsEvents } from "./events";
import { errorFingerprint, scrubText, summarizeStack } from "./protocol";

let client: AnalyticsClient | null = null;
let quitFlusher: ((timeoutMs: number) => Promise<void>) | null = null;

/** The last menu item or command that ran; attached to error reports. */
let lastAction: string | null = null;

export function setAnalyticsClient(next: AnalyticsClient | null): void {
  client = next;
  if (!next) quitFlusher = null;
}

export function getAnalyticsClient(): AnalyticsClient | null {
  return client;
}

export function setQuitFlusher(fn: ((timeoutMs: number) => Promise<void>) | null): void {
  quitFlusher = fn;
}

/**
 * Synchronously seal any pending events to storage (safe to call from non-async
 * unload/close paths where an awaited network request may not complete).
 */
export function sealAnalyticsSync(): void {
  try {
    client?.seal();
  } catch {
    /* never break unload */
  }
}

/**
 * Best-effort bounded flush before the desktop app exits. Seals immediately and
 * waits up to `timeoutMs` for delivery so quitting never hangs on a dead network.
 */
export async function flushAnalyticsBeforeQuit(timeoutMs = 1_500): Promise<void> {
  try {
    if (quitFlusher) {
      await quitFlusher(timeoutMs);
    } else if (client) {
      client.seal();
      await Promise.race([
        client.flush({ keepalive: true }),
        new Promise<void>((r) => setTimeout(r, timeoutMs)),
      ]);
    }
  } catch {
    /* never block quit */
  }
}

/** Record one event from the catalog in ./events.ts. */
export function track<K extends AnalyticsEventName>(name: K, props: AnalyticsEvents[K]): void {
  try {
    client?.track(name, props);
  } catch {
    /* never let instrumentation break the caller */
  }
}

/**
 * The usage key for a menu id. Data-driven lists number their entries
 * (`tracks.setTrack.3`); the index says nothing about the feature and would
 * make one counter per video or track, so it is removed.
 */
export function menuUsageKey(menuId: string): string {
  return `m:${menuId.replace(/\.\d+$/, "")}`;
}

function countAction(key: string): void {
  lastAction = key;
  try {
    client?.count(key);
  } catch {
    /* never let instrumentation break the caller */
  }
}

/** A menu item ran (from the menu bar, the native menu, or Search Menus). */
export function countMenu(menuId: string): void {
  countAction(menuUsageKey(menuId));
}

/** A command ran through the CommandContext (menu, shortcut or canvas gesture). */
export function countCommand(commandName: string): void {
  countAction(`c:${commandName}`);
}

/** A sidebar panel was opened by the user. */
export function countPanel(panelId: string): void {
  try {
    client?.count(`p:${panelId}`);
  } catch {
    /* never let instrumentation break the caller */
  }
}

/**
 * Report an error the user hit. The message and stack are scrubbed of paths,
 * filenames, URLs and email addresses before anything is stored or sent (see
 * `scrubText` / `summarizeStack`), and repeats are counted rather than re-sent.
 */
export function reportError(
  kind: AnalyticsEvents["error"]["kind"],
  message: unknown,
  stack?: unknown,
): void {
  if (!client) return;
  try {
    const text = typeof message === "string" ? message : String(message ?? "");
    client.trackError({
      kind,
      fp: errorFingerprint(kind, text),
      message: scrubText(text),
      stack: summarizeStack(typeof stack === "string" ? stack : null),
      after: lastAction,
    });
  } catch {
    /* never let instrumentation break the caller */
  }
}
