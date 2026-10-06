/**
 * Detect a trained sleap-nn model's head type from its `training_config.yaml`.
 *
 * A sleap-nn model dir's `training_config.yaml` records the model's head under
 * `model_config.head_configs`, where exactly one key is non-null (the active
 * head) and the rest are `null`. This is the same rule `parseTrainingConfig`
 * (src/lib/metrics/loadModelMetrics.ts) uses to label a model's type; extracted
 * here as a standalone, unit-testable helper so the overlay model picker can
 * classify a folder without the Tauri runtime.
 */

import yaml from "js-yaml";

/** Known sleap-nn head-config keys (the value returned by {@link detectModelHead}). */
export type ModelHead =
  | "single_instance"
  | "centroid"
  | "centered_instance"
  | "bottomup"
  | "multi_class_bottomup"
  | "multi_class_topdown";

/**
 * The active head type of a sleap-nn model, from the text of its
 * `training_config.yaml` — the single non-null key under
 * `model_config.head_configs`. Returns `null` on malformed/empty YAML or when
 * no head is present (e.g. every head is `null`, or `head_configs` is missing).
 */
export function detectModelHead(yamlText: string): string | null {
  let doc: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object") doc = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const modelConfig = (doc.model_config ?? {}) as Record<string, unknown>;
  const headConfigs = (modelConfig.head_configs ?? {}) as Record<string, unknown>;
  return Object.entries(headConfigs).find(([, v]) => v != null)?.[0] ?? null;
}
