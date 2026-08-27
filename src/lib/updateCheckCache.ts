/**
 * Session-scoped, TTL-capped cache in front of the `check_update` Tauri
 * command (see src-tauri/src/update_channels.rs).
 *
 * The "latest" channel resolves dynamically via the GitHub Releases API,
 * which is unauthenticated and rate-limited to 60 req/hr per IP. Without
 * this cache, every app startup badge check (App.tsx) AND every time the
 * user opens/re-opens the Environment panel (EnvironmentPanel.tsx) would
 * spend another request each — easy to add up across a shared network, or
 * just from switching channels back and forth in one sitting.
 *
 * A release doesn't land often enough to justify re-checking that
 * frequently, so a result is reused for up to an hour. Failures are never
 * cached, so a rate-limited or offline check can be retried immediately
 * rather than being stuck showing a stale error for the rest of the hour.
 *
 * Also the single choke point that keeps appStore's ambient "something's
 * available" badge fields (stableUpdateAvailable/latestUpdateVersion, etc.)
 * in sync: every completed "stable"/"latest" check writes them here, so the
 * badge reflects whichever code path (startup check or an Environment panel
 * visit) most recently actually checked — rather than only the one-time
 * startup effect that used to own them exclusively.
 */

import { sleapCmd } from "./sleapPlugin";
import { useAppStore, type UpdateChannel } from "@/stores/appStore";

/** Shape returned by the `check_update` Rust command. */
export interface PendingUpdate {
  version: string;
  notes?: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  result: PendingUpdate | null;
  checkedAt: number;
}

const cache = new Map<UpdateChannel, CacheEntry>();
// De-dupes concurrent misses on the same channel (e.g. App.tsx's startup
// check and an already-open Environment panel both checking "latest" at
// once) into a single in-flight request, rather than each firing its own.
const inFlight = new Map<UpdateChannel, Promise<PendingUpdate | null>>();

function recordAmbientBadgeInfo(
  channel: UpdateChannel,
  result: PendingUpdate | null
) {
  if (channel === "stable") {
    useAppStore.getState().setStableUpdateInfo(!!result, result?.version ?? null);
  } else if (channel === "latest") {
    useAppStore.getState().setLatestUpdateInfo(!!result, result?.version ?? null);
  }
}

export async function checkUpdateCached(
  channel: UpdateChannel,
  { force = false }: { force?: boolean } = {}
): Promise<PendingUpdate | null> {
  if (!force) {
    const cached = cache.get(channel);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const pending = inFlight.get(channel);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<PendingUpdate | null>(
        sleapCmd("check_update"),
        { channel }
      );
      cache.set(channel, { result, checkedAt: Date.now() });
      recordAmbientBadgeInfo(channel, result);
      return result;
    } finally {
      inFlight.delete(channel);
    }
  })();
  inFlight.set(channel, promise);
  return promise;
}
