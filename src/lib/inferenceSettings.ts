/**
 * The Inference panel's settings, remembered between sessions on this
 * computer (persisted with the other preferences in appStore). Model paths
 * aren't kept: they belong to a project, and the panel auto-detects them.
 * "Track only" isn't kept either: it's a one-off mode, and coming back to a
 * panel that silently skips pose estimation would be a surprise.
 */
import type { InferenceConfig } from "@/stores/inferenceStore";
import { INFERENCE_DEFAULTS } from "@/lib/inferenceDefaults";

type PanelSettings = Omit<
  InferenceConfig,
  "modelPaths" | "videoIndex" | "frameRange" | "trackOnly" | "centroidOutput" | "skeletonRuns"
>;

export interface SavedInferenceSettings extends Partial<PanelSettings> {
  /** The Inference Target choice ("suggestions", "clip", "custom", …). */
  target?: string;
  /** A custom range's start and end, as typed. */
  customStart?: string;
  customEnd?: string;
}

const TARGETS = new Set([
  "all_videos", "video", "suggestions", "user_labeled", "predicted",
  "random_video", "random", "frame", "custom", "clip",
]);

/** Settings keys and their default values (the type each saved value must have). */
const SETTING_DEFAULTS = Object.fromEntries(
  Object.entries(INFERENCE_DEFAULTS).filter(([k]) => k !== "trackOnly"),
) as Record<string, unknown>;

/** Whether `value` can stand in for a setting whose default is `def`. */
function sameKind(def: unknown, value: unknown): boolean {
  if (def === null) return value === null || (typeof value === "number" && Number.isFinite(value));
  if (typeof def === "number") {
    return (typeof value === "number" && Number.isFinite(value)) || value === null;
  }
  if (Array.isArray(def)) return Array.isArray(value) && value.every((v) => typeof v === "number");
  return typeof value === typeof def;
}

/**
 * The usable part of stored settings: known keys with the right kind of value.
 * Anything else (an older app's keys, a hand-edited file) is dropped.
 */
export function sanitizeSavedInferenceSettings(raw: unknown): SavedInferenceSettings {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "target") {
      if (typeof v === "string" && TARGETS.has(v)) out.target = v;
    } else if (k === "customStart" || k === "customEnd") {
      if (typeof v === "string") out[k] = v;
    } else if (k in SETTING_DEFAULTS && sameKind(SETTING_DEFAULTS[k], v)) {
      out[k] = v;
    }
  }
  return out as SavedInferenceSettings;
}

/** The part of a run's config that's remembered. */
export function settingsToSave(
  config: InferenceConfig,
  ui: { target: string; customStart: string; customEnd: string },
): SavedInferenceSettings {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SETTING_DEFAULTS)) out[k] = (config as unknown as Record<string, unknown>)[k];
  return { ...(out as SavedInferenceSettings), target: ui.target, customStart: ui.customStart, customEnd: ui.customEnd };
}
