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

import { parseTrainingConfig } from "./metrics/loadModelMetrics";
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
  runName: string | null;
  mtimeMs: number;
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
    const hasCheckpoint = runEntries.some(
      (e) => !e.isDirectory && e.name.endsWith(".ckpt")
    );
    if (!hasCheckpoint) continue;

    let yamlText: string;
    try {
      yamlText = await fs.readTextFile(cfgPath);
    } catch {
      continue;
    }
    const cfg = parseTrainingConfig(yamlText);
    if (!cfg.headKey) continue;

    const mtimeMs = await fs.mtimeMs(runDir).catch(() => 0);
    results.push({ path: runDir, headKey: cfg.headKey, runName: cfg.runName, mtimeMs });
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/** Head keys required for each pipeline, mirroring legacy's `_get_head_names_for_pipeline`. */
export const PIPELINE_HEADS: Record<PipelineType, string[]> = {
  "top-down": ["centroid", "centered_instance"],
  "bottom-up": ["bottomup"],
  "single-animal": ["single_instance"],
  "top-down-id": ["centroid", "multi_class_topdown"],
  "bottom-up-id": ["multi_class_bottomup"],
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
    const match = models.find((m) => m.headKey === head);
    if (!match) return [];
    paths.push(match.path);
  }
  return paths;
}
