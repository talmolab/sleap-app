/**
 * Introspect a trained sleap-nn model directory.
 *
 * Inference previously took model directories as bare paths with no idea what
 * was in them: pick the centroid dir where a centered-instance model belongs and
 * the only feedback was an opaque sleap-nn failure minutes later. Every run dir
 * carries a `training_config.yaml`, so read it and say what the model is.
 *
 * This also makes a trained model usable WITHOUT the session that produced it —
 * `trainingStore.modelOutputDirs` is in-memory only, so it empties on restart.
 */

import yaml from "js-yaml";
import type { PipelineType } from "@/stores/inferenceStore";

/** sleap-nn writes this into every run directory. */
export const MODEL_CONFIG_FILENAME = "training_config.yaml";

export interface ModelDirInfo {
  /** The directory the user picked. */
  path: string;
  /**
   * Active head from `model_config.head_configs` — "centroid",
   * "centered_instance", "bottomup", "single_instance", "multi_class_bottomup"
   * or "multi_class_topdown". `null` when the config couldn't be read or parsed.
   */
  headType: string | null;
  /** Active key of `model_config.backbone_config` ("unet", "convnext", "swint"). */
  backbone: string | null;
  /** Input channels the model was trained on — 1 = grayscale, 3 = RGB. */
  inChannels: number | null;
  runName: string | null;
  /** Why introspection failed, for display. `null` when it succeeded. */
  error: string | null;
}

/** Human label for a head type, matching the Training panel's vocabulary. */
export function headTypeLabel(headType: string | null): string {
  switch (headType) {
    case "centroid": return "Centroid";
    case "centered_instance": return "Centered Instance";
    case "bottomup": return "Bottom-Up";
    case "single_instance": return "Single Animal";
    case "multi_class_bottomup": return "Bottom-Up ID";
    case "multi_class_topdown": return "Top-Down ID";
    default: return "Unknown";
  }
}

/**
 * Parse a `training_config.yaml`'s identifying fields.
 *
 * Head detection matches `trainingStore.parseYamlConfig`: a real trained config
 * lists EVERY head with the inactive ones explicitly `null`, so the active head
 * is the first non-null entry, not simply the first key.
 *
 * Returns `null` when the text isn't a usable config at all.
 */
export function describeModelConfig(yamlText: string): Omit<ModelDirInfo, "path" | "error"> | null {
  let doc: Record<string, unknown> | null;
  try {
    doc = yaml.load(yamlText) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;
  const trainerConfig = (doc.trainer_config ?? {}) as Record<string, unknown>;
  const headConfigs = (modelConfig.head_configs ?? {}) as Record<string, unknown>;
  const backboneConfig = (modelConfig.backbone_config ?? {}) as Record<string, unknown>;

  const headType = Object.entries(headConfigs).find(([, v]) => v != null)?.[0] ?? null;
  const backboneEntry = Object.entries(backboneConfig).find(([, v]) => v != null);
  const backbone = backboneEntry?.[0] ?? null;
  const inChannelsRaw = (backboneEntry?.[1] as Record<string, unknown> | undefined)?.in_channels;

  return {
    headType,
    backbone,
    inChannels: typeof inChannelsRaw === "number" ? inChannelsRaw : null,
    runName: typeof trainerConfig.run_name === "string" ? trainerConfig.run_name : null,
  };
}

/**
 * Read + describe a model directory. Never throws: a missing or unreadable
 * config yields an `error` string so the UI can show the path with a warning
 * rather than dropping it (the model may still work — we just can't vouch for it).
 */
export async function readModelDirInfo(path: string): Promise<ModelDirInfo> {
  const base: ModelDirInfo = {
    path,
    headType: null,
    backbone: null,
    inChannels: null,
    runName: null,
    error: null,
  };
  try {
    const { getPlatform } = await import("@/platform");
    const platform = await getPlatform();
    const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const configPath = `${path.replace(/[/\\]+$/, "")}${sep}${MODEL_CONFIG_FILENAME}`;
    if (!(await platform.exists(configPath))) {
      return { ...base, error: `No ${MODEL_CONFIG_FILENAME} in this directory` };
    }
    const bytes = await platform.readFile(configPath);
    const described = describeModelConfig(new TextDecoder().decode(bytes));
    if (!described) return { ...base, error: `Couldn't parse ${MODEL_CONFIG_FILENAME}` };
    return { ...base, ...described };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Work out which inference pipeline a set of loaded models forms, and say
 * what's wrong when they don't form one.
 *
 * Top-down is the only two-model pipeline: a centroid model to find animals
 * plus a centered-instance (or multi-class top-down) model to place keypoints.
 * Everything else is a single model.
 *
 * `pipeline: null` with `problem: null` means "nothing selected yet" — not an
 * error, just incomplete.
 */
export function pipelineForHeadTypes(
  heads: (string | null)[],
): { pipeline: PipelineType | null; problem: string | null } {
  const known = heads.filter((h): h is string => !!h);
  if (known.length === 0) {
    return {
      pipeline: null,
      problem: heads.length > 0 ? "Couldn't identify the selected model(s)." : null,
    };
  }

  const counts = new Map<string, number>();
  for (const h of known) counts.set(h, (counts.get(h) ?? 0) + 1);
  const dupe = [...counts.entries()].find(([, n]) => n > 1);
  if (dupe) {
    return {
      pipeline: null,
      problem: `Two ${headTypeLabel(dupe[0])} models selected — a pipeline uses at most one of each.`,
    };
  }

  const has = (h: string) => counts.has(h);
  const centroid = has("centroid");

  if (centroid && has("centered_instance")) return { pipeline: "top-down", problem: null };
  if (centroid && has("multi_class_topdown")) return { pipeline: "top-down-id", problem: null };

  if (known.length === 1) {
    switch (known[0]) {
      // A lone centroid model localizes animals without posing them — that's
      // the AL locator path, a real pipeline rather than half a top-down one.
      case "centroid": return { pipeline: "centroid", problem: null };
      case "bottomup": return { pipeline: "bottom-up", problem: null };
      case "single_instance": return { pipeline: "single-animal", problem: null };
      case "multi_class_bottomup": return { pipeline: "bottom-up-id", problem: null };
      case "centered_instance":
        return { pipeline: null, problem: "Centered Instance needs a Centroid model too (top-down uses both)." };
      case "multi_class_topdown":
        return { pipeline: null, problem: "Top-Down ID needs a Centroid model too." };
    }
  }

  return {
    pipeline: null,
    problem: `${known.map(headTypeLabel).join(" + ")} isn't a valid pipeline combination.`,
  };
}

/**
 * Cross-model sanity checks that don't prevent a run but usually mean a mistake.
 * Returned separately from {@link pipelineForHeadTypes}'s hard problems.
 */
export function modelCompatWarnings(infos: ModelDirInfo[]): string[] {
  const warnings: string[] = [];
  const channels = new Set(
    infos.map((i) => i.inChannels).filter((c): c is number => typeof c === "number"),
  );
  if (channels.size > 1) {
    warnings.push(
      `Models expect different input channels (${[...channels].sort().join(" vs ")}) — they were trained on different image types.`,
    );
  }
  const backbones = new Set(infos.map((i) => i.backbone).filter((b): b is string => !!b));
  if (backbones.size > 1) {
    warnings.push(`Mixed backbones (${[...backbones].join(", ")}).`);
  }
  return warnings;
}
