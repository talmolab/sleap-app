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
 */

import { sleapCmd } from "./sleapPlugin";
import type { UpdateChannel } from "@/stores/appStore";

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

export async function checkUpdateCached(
  channel: UpdateChannel
): Promise<PendingUpdate | null> {
  const cached = cache.get(channel);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.result;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<PendingUpdate | null>(sleapCmd("check_update"), {
    channel,
  });
  cache.set(channel, { result, checkedAt: Date.now() });
  return result;
}
