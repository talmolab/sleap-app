/**
 * Auto-detect trained sleap-nn models in a project's `models/` folder, so the
 * Inference panel can default to the most recently trained model per head
 * without the user manually browsing to it every time.
 *
 * Mirrors legacy SLEAP's `TrainingConfigsGetter` / `ConfigFileInfo.has_trained_model`
 * (sleap/gui/learning/configs.py): scan `{projectDir}/models/` one level deep,
 * keep only run dirs with a `training_config.yaml` AND a checkpoint file, and
 * prefer the most recently modified.
 *
 * File access is injectable so this is unit-testable without the Tauri runtime.
 */

import yaml from "js-yaml";
import { MODEL_TYPE_LABELS, parseTrainingConfig } from "./metrics/loadModelMetrics";
import { cropModeOf, headTypeMatches, type CropMode } from "./bboxModels";
import type { PipelineType } from "@/stores/inferenceStore";

export interface ModelDirEntry {
  name: string;
  isDirectory: boolean;
}

/** Minimal filesystem surface this scanner needs (injectable for tests). */
export interface ModelFsAccess {
  readDir(path: string): Promise<ModelDirEntry[]>;
  readTextFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Last-modified time in epoch ms, or 0 if unavailable. */
  mtimeMs(path: string): Promise<number>;
}

/** Default reader backed by the Tauri fs plugin (desktop-only at runtime). */
function defaultFs(): ModelFsAccess {
  return {
    async readDir(path) {
      const { readDir } = await import("@tauri-apps/plugin-fs");
      const entries = await readDir(path);
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
    },
    async readTextFile(path) {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      return readTextFile(path);
    },
    async exists(path) {
      const { exists } = await import("@tauri-apps/plugin-fs");
      return exists(path);
    },
    async mtimeMs(path) {
      const { stat } = await import("@tauri-apps/plugin-fs");
      const info = await stat(path);
      return info.mtime ? info.mtime.getTime() : 0;
    },
  };
}

/** Join a directory and a filename using the directory's path separator. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return `${trimmed}${sep}${name}`;
}

export interface DiscoveredModel {
  /** Path to the model's run directory — what `--model_paths` expects. */
  path: string;
  headKey: string;
  /**
   * How the model crops each instance (`preprocessing.crop_mode`): only
   * meaningful for centered-instance heads, where a box-crop model needs a box
   * detector in front of it. Optional so hand-built entries (tests, callers
   * without the YAML) still type-check; absent means unknown.
   */
  cropMode?: CropMode | null;
  runName: string | null;
  mtimeMs: number;
  /**
   * Filename (not path) of the checkpoint to seed a Resume/Fine-tune from,
   * preferring `last.ckpt` (most recent epoch) over `best.ckpt` (best by
   * monitored metric, which sleap-nn's `ModelCheckpoint` always writes when
   * `save_top_k >= 1`), else the first other `*.ckpt` file found. `null` only
   * if `readDir` somehow returned no `.ckpt` file despite `hasCheckpoint`
   * having passed (shouldn't happen in practice).
   */
  checkpointFile: string | null;
}

/** Pick the preferred checkpoint filename from a run directory's entries. */
function pickCheckpointFile(runEntries: ModelDirEntry[]): string | null {
  const ckptFiles = runEntries.filter((e) => !e.isDirectory && e.name.endsWith(".ckpt"));
  return (
    ckptFiles.find((e) => e.name === "last.ckpt")?.name ??
    ckptFiles.find((e) => e.name === "best.ckpt")?.name ??
    ckptFiles[0]?.name ??
    null
  );
}

/**
 * Scan `{projectDir}/models/` (one level deep) for trained model run
 * directories, sorted most-recently-trained first. Returns `[]` if there's no
 * `models/` folder or it has no trained runs.
 */
export async function findTrainedModels(
  projectDir: string,
  fs: ModelFsAccess = defaultFs()
): Promise<DiscoveredModel[]> {
  const modelsDir = joinPath(projectDir, "models");
  if (!(await fs.exists(modelsDir))) return [];

  let entries: ModelDirEntry[];
  try {
    entries = await fs.readDir(modelsDir);
  } catch {
    return [];
  }

  const results: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const runDir = joinPath(modelsDir, entry.name);
    const cfgPath = joinPath(runDir, "training_config.yaml");
    if (!(await fs.exists(cfgPath))) continue;

    let runEntries: ModelDirEntry[];
    try {
      runEntries = await fs.readDir(runDir);
    } catch {
      continue;
    }
    const checkpointFile = pickCheckpointFile(runEntries);
    if (!checkpointFile) continue;

    let yamlText: string;
    try {
      yamlText = await fs.readTextFile(cfgPath);
    } catch {
      continue;
    }
    const cfg = parseTrainingConfig(yamlText);
    if (!cfg.headKey) continue;
    let cropMode: CropMode | null = null;
    try {
      cropMode = cropModeOf(yaml.load(yamlText));
    } catch {
      // parseTrainingConfig already read it; unknown crop mode is fine.
    }

    const mtimeMs = await fs.mtimeMs(runDir).catch(() => 0);
    results.push({ path: runDir, headKey: cfg.headKey, cropMode, runName: cfg.runName, mtimeMs, checkpointFile });
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/**
 * Head types required for each pipeline, mirroring legacy's
 * `_get_head_names_for_pipeline`. Box pipelines use the head families of
 * `headTypeMatches` (lib/bboxModels.ts): "bbox" is either detector, and a
 * top-down-box pipeline wants a box-crop centered-instance model.
 */
export const PIPELINE_HEADS: Record<PipelineType, string[]> = {
  "top-down": ["centroid", "centered_instance"],
  "bottom-up": ["bottomup"],
  "single-animal": ["single_instance"],
  "top-down-id": ["centroid", "multi_class_topdown"],
  "bottom-up-id": ["multi_class_bottomup"],
  bbox: ["bbox"],
  "top-down-bbox": ["bbox", "centered_instance_bbox"],
};


/**
 * Pick the most recently trained model for each head `pipeline` requires, in
 * head order. Returns `[]` if any required head has no trained model — a
 * partial set can't run inference, so it's better left for the user to fill
 * in manually than to hand back an incomplete `--model_paths` list.
 */
export function pickModelsForPipeline(
  models: DiscoveredModel[],
  pipeline: PipelineType
): string[] {
  const heads = PIPELINE_HEADS[pipeline];
  const paths: string[] = [];
  for (const head of heads) {
    const match = models.find((m) => headTypeMatches(head, m));
    if (!match) return [];
    paths.push(match.path);
  }
  return paths;
}

/**
 * The head a model directory was trained for, read from its
 * `training_config.yaml`, or `null` when it can't be read.
 */
export async function readModelHead(
  runDir: string,
  fs: ModelFsAccess = defaultFs()
): Promise<ModelHead | null> {
  try {
    const text = await fs.readTextFile(joinPath(runDir, "training_config.yaml"));
    return { headKey: parseTrainingConfig(text).headKey, cropMode: cropModeOf(yaml.load(text)) };
  } catch {
    return null;
  }
}

/**
 * The head a model directory was trained for, read from its
 * `training_config.yaml`, or `null` when it can't be read.
 */
export async function readModelHeadKey(
  runDir: string,
  fs: ModelFsAccess = defaultFs()
): Promise<string | null> {
  try {
    return parseTrainingConfig(await fs.readTextFile(joinPath(runDir, "training_config.yaml"))).headKey;
  } catch {
    return null;
  }
}

const PIPELINE_LABELS: Record<PipelineType, string> = {
  "top-down": "Top-Down",
  "bottom-up": "Bottom-Up",
  "single-animal": "Single Animal",
  "top-down-id": "Top-Down + ID",
  "bottom-up-id": "Bottom-Up + ID",
  bbox: "Box Detector",
  "top-down-bbox": "Top-Down (Box Crops)",
};

/** Names for the head families box pipelines use (see lib/bboxModels.ts). */
const FAMILY_LABELS: Record<string, string> = {
  bbox: "Box Detector",
  centered_instance_bbox: "Centered Instance (box crops)",
};

/** A model's head and, when known, its crop mode (what a pipeline slot needs). */
export interface ModelHead {
  headKey: string | null;
  cropMode?: CropMode | null;
}

/**
 * Why the chosen models can't run `pipeline`, or `null` when they can. Like
 * legacy SLEAP's `_validate_pipeline`, inference needs a trained model for
 * every head the pipeline uses. `headKeys` holds each model's head, `null`
 * where it is unknown (a worker path, or an unreadable config); then only the
 * number of models is checked.
 */
export function pipelineModelsProblem(
  pipeline: PipelineType,
  heads: (string | ModelHead | null)[]
): string | null {
  const required = PIPELINE_HEADS[pipeline];
  const label = (h: string) => FAMILY_LABELS[h] ?? MODEL_TYPE_LABELS[h] ?? h;
  // Plain head keys still work; a ModelHead also carries the crop mode, so a
  // box-crop centered-instance model only fills a Box Crops slot.
  const headKeys = heads.map((h) => (h === null || typeof h === "string" ? h : h.headKey));
  const runs: ModelHead[] = heads
    .filter((h): h is string | ModelHead => h !== null)
    .map((h) => (typeof h === "string" ? { headKey: h, cropMode: null } : h));
  const needs = `${PIPELINE_LABELS[pipeline]} needs ${required.length === 1 ? "a" : "these"} model${required.length === 1 ? "" : "s"}: ${required.map(label).join(" + ")}.`;
  if (headKeys.length === 0) return null;
  if (headKeys.length < required.length) return `${needs} Add the missing one.`;
  if (headKeys.some((h) => h == null)) return null;
  const missing = required.filter((h) => !runs.some((r) => headTypeMatches(h, r)));
  if (missing.length > 0) return `${needs} Missing: ${missing.map(label).join(", ")}.`;
  return null;
}
