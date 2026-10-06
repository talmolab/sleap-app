/**
 * Per-video "can the worker see this?" check for remote training/inference
 * (PR3, docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3a.3). Pure:
 * everything it needs (path rules, worker mounts, a `stat` probe) is passed
 * in — no store/connectStore dependency here, so it's trivially testable and
 * reusable from both the data-summary UI (PR3b) and `trainingStore`.
 */
import { isWorkerPath, translatePath, detectPrefixDiff, type PathMapping } from "@/lib/pathMappings";
import type { Labels } from "@/types";

/**
 * Why a video isn't visible on the worker:
 * - "no-location": no worker mount prefix and no path rule covers it — we
 *   don't even have a candidate worker path to check.
 * - "not-found": we have a candidate path, but the worker's `fs.stat` says
 *   it doesn't exist there.
 * - "outside-shares": the candidate path (whether pass-through or
 *   rule-translated) isn't under any of the worker's mounts — the worker's
 *   `fs.stat` only serves paths under a configured mount, so this is never
 *   checked remotely at all.
 * - "error": the `stat` call itself failed (e.g. a dropped connection).
 */
export type HiddenReason = "no-location" | "not-found" | "outside-shares" | "error";

export interface VideoVisibility {
  index: number;
  local: string;
  /** The worker-side path this video would resolve to, or `null` if none could be computed at all ("no-location"). */
  worker: string | null;
  visible: boolean;
  reason?: HiddenReason;
}

export type VisibilityCase = "all" | "some" | "none";

const DEFAULT_CONCURRENCY = 8;

/** A video's own path(s) the same way `trainingStore` has always read them: a string, or an image-sequence video's first frame. */
export function projectVideoPaths(labels: Labels): string[] {
  return labels.videos.map((video) =>
    typeof video.filename === "string" ? video.filename : video.filename[0],
  );
}

/**
 * Checks every video path against the worker, bounded to `deps.concurrency`
 * (default 8) concurrent `stat` calls — only paths that resolve to a
 * worker-mount candidate ever call `stat`; "no-location"/"outside-shares"
 * are decided locally and never consume a concurrency slot.
 */
export async function checkVideoVisibility(
  videoPaths: string[],
  deps: {
    rules: PathMapping[];
    mounts: string[];
    stat: (workerPath: string) => Promise<boolean>;
    concurrency?: number;
  },
): Promise<VideoVisibility[]> {
  const results: VideoVisibility[] = videoPaths.map((local, index) => {
    const candidate = isWorkerPath(local, deps.mounts) ? local : translatePath(local, deps.rules);
    if (candidate === null) {
      return { index, local, worker: null, visible: false, reason: "no-location" };
    }
    if (!isWorkerPath(candidate, deps.mounts)) {
      return { index, local, worker: candidate, visible: false, reason: "outside-shares" };
    }
    // Pending: needs a `stat` call below. `reason` stays unset as the marker.
    return { index, local, worker: candidate, visible: false };
  });

  const pending = results
    .map((r, i) => (r.reason === undefined ? i : -1))
    .filter((i): i is number => i >= 0);

  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  const runOne = async (): Promise<void> => {
    while (cursor < pending.length) {
      const i = pending[cursor++];
      const r = results[i];
      try {
        const exists = await deps.stat(r.worker as string);
        results[i] = exists ? { ...r, visible: true } : { ...r, visible: false, reason: "not-found" };
      } catch {
        results[i] = { ...r, visible: false, reason: "error" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runOne));

  return results;
}

/** `[]` counts as "all" — there's nothing hidden to warn about. */
export function classifyVisibility(v: VideoVisibility[]): VisibilityCase {
  if (v.length === 0) return "all";
  const visibleCount = v.filter((x) => x.visible).length;
  if (visibleCount === v.length) return "all";
  if (visibleCount === 0) return "none";
  return "some";
}

/**
 * The path rule to remember after the user manually locates a hidden video
 * on the worker (RemoteFileBrowser's "Locate on worker…", PR3b) — a
 * directory-prefix rule when one's detectable (so sibling videos under the
 * same moved directory resolve automatically too), else an exact single-file
 * rule.
 */
export function inferRuleFromLocate(local: string, worker: string): PathMapping {
  return detectPrefixDiff(local, worker) ?? { local, worker };
}
