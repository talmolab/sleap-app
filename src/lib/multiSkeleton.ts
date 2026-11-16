/**
 * Helpers for projects that hold several skeletons (e.g. a mouse skeleton and a
 * 1-node pellet skeleton labeled on the same video).
 *
 * sleap-io.js is already plural (`Labels.skeletons`, per-instance
 * `instance.skeleton`). The app keeps one ACTIVE skeleton (`appStore.skeleton`)
 * for editing and for new instances. Workflows that still assume a single
 * skeleton (training, inference, Label QC, analysis exports) refuse with a clear
 * message via {@link multiSkeletonBlock} instead of silently using the first.
 */

import type { Labels, Skeleton } from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";

/** True when the project holds two or more skeletons. */
export function hasMultipleSkeletons(
  labels: Pick<Labels, "skeletons"> | null | undefined,
): boolean {
  return (labels?.skeletons?.length ?? 0) > 1;
}

/**
 * The message shown when `feature` can't run on a project with several
 * skeletons, e.g. "Training with several skeletons isn't supported yet."
 */
export function multiSkeletonMessage(feature: string): string {
  return `${feature} with several skeletons isn't supported yet.`;
}

/**
 * Guard for a workflow that needs a single skeleton. Returns the message (and
 * shows it as a toast unless `toastIt` is false) when the project has several
 * skeletons, or null when it's fine to continue.
 */
export function multiSkeletonBlock(
  labels: Pick<Labels, "skeletons"> | null | undefined,
  feature: string,
  { toastIt = true }: { toastIt?: boolean } = {},
): string | null {
  if (!hasMultipleSkeletons(labels)) return null;
  const message = multiSkeletonMessage(feature);
  if (toastIt) {
    toast.info(message, {
      description: "Pick one skeleton per project for now, or wait for per-skeleton support.",
    });
  }
  return message;
}

/** Display name for a skeleton (its name, or "Skeleton N" by position). */
export function skeletonDisplayName(
  skeleton: Skeleton,
  skeletons: readonly Skeleton[],
): string {
  const name = skeleton.name?.trim();
  if (name) return name;
  const idx = skeletons.indexOf(skeleton);
  return `Skeleton ${idx >= 0 ? idx + 1 : "?"}`;
}

/** A default name for a new skeleton that no existing skeleton uses. */
export function nextSkeletonName(skeletons: readonly Skeleton[]): string {
  const taken = new Set(skeletons.map((s) => s.name?.trim()).filter(Boolean));
  for (let n = skeletons.length + 1; ; n++) {
    const candidate = `skeleton ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Whether `name` is usable for a skeleton (non-empty, not taken by another). */
export function isValidSkeletonName(
  name: string,
  skeletons: readonly Skeleton[],
  except?: Skeleton | null,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !skeletons.some((s) => s !== except && s.name?.trim() === trimmed);
}
