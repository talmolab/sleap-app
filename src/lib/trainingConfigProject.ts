/**
 * Keep the project-derived name lists in a sleap-nn training config in step
 * with the project being trained.
 *
 * After training, sleap-nn writes the lists it derived from the labels back into
 * the run's `training_config.yaml`:
 *  - `pafs.edges`: the skeleton's edges, as `[source, destination]` names
 *  - `class_maps.classes` / `class_vectors.classes`: the ID models' track names
 *
 * sleap-nn only derives a list when it is `null`
 * (`sleap_nn/training/model_trainer.py`). A config reused from an earlier run
 * (fine-tune, resume, reuse, or a config file loaded from disk) therefore trains
 * on the old edges or track names after the skeleton or tracks change, without
 * any warning.
 *
 * A list is kept when it holds exactly what the project has now, in any order,
 * and cleared (`null`, so sleap-nn derives it again) otherwise. A list that still
 * matches is kept because its order matters. A model's PAF channels follow the
 * edge order, and sleap-nn builds `classes` as `list(set(tracks))`, whose order
 * changes from one Python run to the next. Clearing a list that still matches
 * would reorder the outputs of a model that is resumed or fine-tuned.
 */

import type { Labels } from "@/types";

/** What the project being trained has: one skeleton's edges and its track names. */
export interface ProjectHeadContext {
  /** Directed edges as `[source, destination]` node names. */
  edges: [string, string][];
  /** Names of every track in the project (sleap-nn reads `labels.tracks`). */
  trackNames: string[];
}

/**
 * The context for `labels`, or `null` when it can't stand for the training data:
 * no labels, or not exactly one skeleton.
 */
export function projectHeadContext(labels: Labels | null | undefined): ProjectHeadContext | null {
  if (!labels || labels.skeletons.length !== 1) return null;
  const skeleton = labels.skeletons[0];
  return {
    edges: skeleton.edges.map((e) => [e.source.name, e.destination.name] as [string, string]),
    trackNames: labels.tracks.map((t) => t.name).filter((n): n is string => typeof n === "string"),
  };
}

function sameMembers(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function edgeKeys(edges: unknown): string[] | null {
  if (!Array.isArray(edges)) return null;
  const keys: string[] = [];
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2) return null;
    keys.push(`${String(e[0])}\u0000${String(e[1])}`);
  }
  return keys;
}

/**
 * Clear (`null`) each `edges` / `classes` list under `headConfigs` that no
 * longer matches `ctx`. Lists already `null` are left alone. Mutates in place.
 * Returns the dotted paths it cleared (`"bottomup.pafs.edges"`), for logging.
 */
export function reconcileHeadNameLists(
  headConfigs: Record<string, unknown>,
  ctx: ProjectHeadContext,
): string[] {
  const cleared: string[] = [];
  const wantEdges = ctx.edges.map(([s, d]) => `${s}\u0000${d}`);
  for (const [headName, headVal] of Object.entries(headConfigs)) {
    if (!headVal || typeof headVal !== "object") continue;
    for (const [subName, subVal] of Object.entries(headVal as Record<string, unknown>)) {
      if (!subVal || typeof subVal !== "object") continue;
      const sub = subVal as Record<string, unknown>;
      if (sub.edges != null) {
        const have = edgeKeys(sub.edges);
        if (!have || !sameMembers(have, wantEdges)) {
          sub.edges = null;
          cleared.push(`${headName}.${subName}.edges`);
        }
      }
      if (sub.classes != null) {
        const have = Array.isArray(sub.classes) ? sub.classes.map(String) : null;
        if (!have || !sameMembers(have, ctx.trackNames)) {
          sub.classes = null;
          cleared.push(`${headName}.${subName}.classes`);
        }
      }
    }
  }
  return cleared;
}
