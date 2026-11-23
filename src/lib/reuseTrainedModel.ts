/**
 * "Use a trained model" for one stage of a training pipeline — PyQt SLEAP's
 * per-tab "Reuse model (don't retrain)" option (sleap/gui/learning/dialog.py
 * `TrainingEditorWidget.use_trained` + runners.py `run_gui_training`'s
 * `dont_retrain` branch): a head tab that reuses a trained model is skipped
 * in training, and its model goes straight into post-training inference with
 * the newly trained ones, in pipeline order.
 *
 * Pure helpers (plus one injectable-fs scanner) so the dialog, the Training
 * panel and `trainingStore.startTraining` agree on what "reused" means.
 */

import yaml from "js-yaml";
import { findTrainedModels, type DiscoveredModel, type ModelFsAccess } from "./modelDiscovery";
import { parseTrainingConfig } from "./metrics/loadModelMetrics";
import { headTypeMatches, cropModeOf, type CropMode } from "./bboxModels";
import { slotToHeadType } from "./trainingProfiles";
import type { ConfigFile, ModelType } from "@/stores/trainingStore";

/** A trained model picked to stand in for one pipeline stage. */
export interface ReusedModel {
  /** The model's run directory — what `--model_paths` takes. */
  path: string;
  runName: string | null;
  headKey: string;
  /** Node names the model was trained on, `null` when its config doesn't record them. */
  nodeNames: string[] | null;
  /** The top-down anchor part it was trained with (`null`: bounding-box center). `undefined`: not a top-down head. */
  anchorPart?: string | null;
}

/**
 * A slot's reuse state, kept on its `ConfigFile`. Present = the "Use a
 * trained model" box is checked; `model` is `null` until one is picked.
 */
export interface ReuseSelection {
  model: ReusedModel | null;
}

/** Whether this slot is set to reuse a trained model instead of training. */
export function isReused(cf: ConfigFile | undefined | null): boolean {
  return !!cf?.reuse;
}

/** The slots that actually train, in pipeline order (reused ones dropped). */
export function slotsToTrain(slots: string[], configs: ConfigFile[]): string[] {
  return slots.filter((slot) => !isReused(configs.find((c) => c.slot === slot)));
}

export type SkeletonCompat = "match" | "mismatch" | "unknown";

/**
 * Whether a model's nodes fit the project's skeleton: the same node names
 * (order doesn't matter — predictions map back by name). `unknown` when
 * either side has no recorded nodes.
 */
export function skeletonCompat(
  modelNodes: string[] | null | undefined,
  projectNodes: string[] | null | undefined,
): SkeletonCompat {
  if (!modelNodes?.length || !projectNodes?.length) return "unknown";
  const want = new Set(projectNodes);
  const have = new Set(modelNodes);
  if (have.size !== want.size) return "mismatch";
  return [...have].every((n) => want.has(n)) ? "match" : "mismatch";
}

/** A discovered model plus what the picker needs from its config. */
export interface ScannedModel extends DiscoveredModel {
  nodeNames: string[] | null;
  anchorPart?: string | null;
}

/** One row of a slot's trained-model picker. */
export interface ReuseCandidate {
  model: ReusedModel;
  mtimeMs: number;
  compat: SkeletonCompat;
}

/**
 * The trained models that can stand in for `slot`: same head type (box-crop
 * vs fixed-crop centered-instance included, via `headTypeMatches`), in scan
 * order (newest first), each tagged with its skeleton compatibility. Models
 * of another head type are left out; skeleton mismatches stay in (the picker
 * shows them disabled, with the reason).
 */
export function reuseCandidatesForSlot(
  scanned: ScannedModel[],
  modelType: ModelType,
  slot: string,
  projectNodes: string[] | null | undefined,
): ReuseCandidate[] {
  const headType = slotToHeadType(modelType, slot);
  return scanned
    .filter((m) => headTypeMatches(headType, m))
    .map((m) => ({
      model: {
        path: m.path,
        runName: m.runName,
        headKey: m.headKey,
        nodeNames: m.nodeNames,
        ...(m.anchorPart !== undefined ? { anchorPart: m.anchorPart } : {}),
      },
      mtimeMs: m.mtimeMs,
      compat: skeletonCompat(m.nodeNames, projectNodes),
    }));
}

/**
 * Why `slot` can't reuse this model, or `null` when it can: wrong head type
 * or a different skeleton. An unknown skeleton is allowed (PyQt only checks
 * the head).
 */
export function reuseModelProblem(
  model: { headKey: string | null; nodeNames: string[] | null; cropMode?: CropMode | null },
  modelType: ModelType,
  slot: string,
  projectNodes: string[] | null | undefined,
): string | null {
  const headType = slotToHeadType(modelType, slot);
  if (!model.headKey) return "That folder has no readable training_config.yaml.";
  if (!headTypeMatches(headType, model)) {
    return `That model was trained as "${model.headKey}" and can't be used for this stage.`;
  }
  if (skeletonCompat(model.nodeNames, projectNodes) === "mismatch") {
    return "That model was trained on a different skeleton (its node names don't match this project's).";
  }
  return null;
}

/**
 * Why training can't start with the current reuse choices, or `null`: a
 * checked box with no model picked, or — on a Connect worker — every stage
 * reused (the worker's inference job reads the labels file a train job
 * uploads, so there must be something to train there; run inference instead).
 */
export function reuseStartProblem(
  slots: string[],
  configs: ConfigFile[],
  label: (slot: string) => string,
  opts: { remote?: boolean } = {},
): string | null {
  for (const slot of slots) {
    const cf = configs.find((c) => c.slot === slot);
    if (cf?.reuse && !cf.reuse.model) {
      return `Pick a trained model for ${label(slot)}, or uncheck "Use a trained model".`;
    }
  }
  if (opts.remote && slots.length > 0 && slotsToTrain(slots, configs).length === 0) {
    return "Every stage uses a trained model, so there is nothing to train on the worker. Run inference from the Inference panel instead.";
  }
  return null;
}

/**
 * The full `--model_paths` list in pipeline order: each reused slot's model
 * (through `reusedPath`, so a Connect run can pass its worker-side path), and
 * the newly trained models — in the order they trained — for the rest. A
 * trained slot with no reported path is left out, as before this feature.
 */
export function pipelineModelPaths(
  slots: string[],
  configs: ConfigFile[],
  trainedPaths: (string | null | undefined)[],
  reusedPath: (model: ReusedModel) => string = (m) => m.path,
): string[] {
  const out: string[] = [];
  let next = 0;
  for (const slot of slots) {
    const cf = configs.find((c) => c.slot === slot);
    if (cf?.reuse) {
      if (cf.reuse.model) out.push(reusedPath(cf.reuse.model));
    } else {
      const p = trainedPaths[next++];
      if (p) out.push(p);
    }
  }
  return out;
}

// ── Reading model folders ────────────────────────────────────────────

/** The anchor part a top-down head was trained with; `undefined` when it's not a top-down head. */
export function anchorPartOf(yamlText: string): string | null | undefined {
  try {
    const doc = yaml.load(yamlText) as Record<string, unknown> | null;
    const modelConfig = (doc?.model_config ?? {}) as Record<string, unknown>;
    const heads = (modelConfig.head_configs ?? {}) as Record<string, unknown>;
    for (const key of ["centroid", "centered_instance"]) {
      const head = heads[key] as Record<string, unknown> | null | undefined;
      if (!head) continue;
      const confmaps = (head.confmaps ?? head) as Record<string, unknown>;
      const anchor = confmaps.anchor_part;
      return typeof anchor === "string" && anchor ? anchor : null;
    }
  } catch {
    // Unparseable: no anchor to report.
  }
  return undefined;
}

/** What a model folder's `training_config.yaml` says, for the picker and its checks. */
export function describeModelConfig(path: string, yamlText: string): Omit<ScannedModel, "mtimeMs" | "checkpointFile"> {
  const info = parseTrainingConfig(yamlText);
  let cropMode: CropMode | null = null;
  try {
    cropMode = cropModeOf(yaml.load(yamlText));
  } catch {
    // Unknown crop mode is fine.
  }
  const anchorPart = anchorPartOf(yamlText);
  return {
    path,
    headKey: info.headKey ?? "",
    cropMode,
    runName: info.runName,
    nodeNames: info.nodeNames,
    ...(anchorPart !== undefined ? { anchorPart } : {}),
  };
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

async function readText(path: string, fs?: ModelFsAccess): Promise<string> {
  if (fs) return fs.readTextFile(path);
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(path);
}

/**
 * Every trained model under each directory's `models/` folder (one level
 * deep, like the Inference panel's auto-detect), newest first, de-duplicated
 * by path, with node names and anchor part read from its config.
 */
export async function scanReusableModels(
  projectDirs: string[],
  fs?: ModelFsAccess,
): Promise<ScannedModel[]> {
  const seen = new Set<string>();
  const out: ScannedModel[] = [];
  for (const dir of projectDirs) {
    if (!dir) continue;
    const found = await findTrainedModels(dir, fs);
    for (const m of found) {
      if (seen.has(m.path)) continue;
      seen.add(m.path);
      try {
        const described = describeModelConfig(m.path, await readText(joinPath(m.path, "training_config.yaml"), fs));
        out.push({ ...m, nodeNames: described.nodeNames, ...(described.anchorPart !== undefined ? { anchorPart: described.anchorPart } : {}) });
      } catch {
        out.push({ ...m, nodeNames: null });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Read a model folder the user browsed to: its config, and whether it holds
 * a checkpoint. `null` when there's no readable `training_config.yaml`.
 */
export async function readModelFolder(
  path: string,
  fs: Pick<ModelFsAccess, "readTextFile" | "readDir">,
): Promise<(Omit<ScannedModel, "mtimeMs" | "checkpointFile"> & { hasCheckpoint: boolean }) | null> {
  let text: string;
  try {
    text = await fs.readTextFile(joinPath(path, "training_config.yaml"));
  } catch {
    return null;
  }
  let hasCheckpoint = false;
  try {
    hasCheckpoint = (await fs.readDir(path)).some((e) => !e.isDirectory && e.name.endsWith(".ckpt"));
  } catch {
    // Can't list it: treat as no checkpoint.
  }
  return { ...describeModelConfig(path, text), hasCheckpoint };
}

/** The folder holding a file (`""` for a bare filename). */
export function dirOf(path: string | null | undefined): string {
  if (!path) return "";
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** The last path segment (a run folder's name). */
export function baseName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? path;
}
