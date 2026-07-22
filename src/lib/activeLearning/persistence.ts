/**
 * Persist the active-learning workflow config INSIDE the `.slp` project (issue
 * #212 follow-up).
 *
 * The config is stored under a namespaced key in the labels' `provenance` dict,
 * which sleap-io.js round-trips through the SLP `/metadata` JSON on every writer
 * (in-memory `saveSlpToBytes`, the streaming embedded-pkg writer, and — because
 * the change shows up in `buildMetadataJson` — the fast in-place edit-save,
 * whose gate then rewrites `/metadata`). So the workflow travels WITH the
 * project file: reopen the `.slp` and the builder is populated again, no
 * separate `active-learning.yaml` needed.
 *
 * Provenance is a free-form dict in the SLEAP format; an extra app-scoped key is
 * additive and preserved by Python sleap-io / sleap-nn, which never read it.
 *
 * Two choke points call in here:
 *   - {@link syncActiveLearningProvenance} at save time (saveProject.ts).
 *   - {@link hydrateActiveLearningStore} at load time (appStore.setLabels).
 */

import type { Labels } from "@talmolab/sleap-io.js";
import {
  normalizeActiveLearningConfig,
  type ActiveLearningConfig,
} from "./config";
import { useActiveLearningStore } from "@/stores/activeLearningStore";

/** Provenance key holding the serialized workflow config (plain JSON object). */
export const AL_PROVENANCE_KEY = "sleap_app_active_learning";

/** Node names of the project's first skeleton (validation target on adopt). */
function skeletonNodeNames(labels: Labels): string[] | undefined {
  const nodes = labels.skeletons?.[0]?.nodes;
  return nodes?.map((n) => n.name);
}

/**
 * Write `config` into (or clear it from) the labels' provenance. Mutates the
 * live labels object so every save path serializes it. Storing `null` removes
 * the key, so turning AL off for a project doesn't leave a stale workflow behind.
 */
export function writeActiveLearningToProvenance(
  labels: Labels,
  config: ActiveLearningConfig | null,
): void {
  if (!labels.provenance) labels.provenance = {};
  if (config) labels.provenance[AL_PROVENANCE_KEY] = config;
  else delete labels.provenance[AL_PROVENANCE_KEY];
}

/**
 * Save-time sync: mirror the current AL store config into `labels` provenance so
 * the next SLP write persists it. Call before serializing.
 */
export function syncActiveLearningProvenance(labels: Labels): void {
  writeActiveLearningToProvenance(labels, useActiveLearningStore.getState().config);
}

/**
 * Load-time hydrate: adopt the workflow saved in `labels` provenance into the AL
 * store (validated against the project skeleton), or clear the store when the
 * project has none. Called from `appStore.setLabels` on every project load / new
 * project, so switching projects never leaks the previous project's workflow.
 * Malformed stored data is treated as "no config" rather than throwing.
 */
export function hydrateActiveLearningStore(labels: Labels): void {
  const store = useActiveLearningStore.getState();
  const raw = labels.provenance?.[AL_PROVENANCE_KEY];
  if (raw && typeof raw === "object") {
    try {
      store.setConfig(normalizeActiveLearningConfig(raw), skeletonNodeNames(labels));
      return;
    } catch {
      // Corrupt/incompatible payload — fall through to a clean slate.
    }
  }
  store.clear();
}
