/**
 * Pure spec builders for the launcher wizard (PR5b) — starting a job on
 * data that already lives on a worker (design §4.3), seeding the wizard
 * from a past run ("Run again"), and the "Run inference" row action on an
 * already-finished training run. Nothing here touches a store or a
 * connection; every input (the worker-side `Labels`, its path, the configs)
 * is handed in by the caller, which for the wizard means `loadWorkerLabels`
 * (`workerLabels.ts`) already ran.
 */
import type { Labels } from "@talmolab/sleap-io.js";
import type { TrainJobSpec, TrackJobSpec } from "@/lib/sleapConnect";
import type { JobProject } from "@/lib/protocolV1/client";
import {
  getConfigSlots,
  applyHyperparamsToYaml,
  resolveRemoteRunName,
  resolveRemoteMaxStride,
  useTrainingStore,
  type ConfigFile,
  type ModelType,
} from "@/stores/trainingStore";
import { detectVideoChannels, resolveInputChannels } from "@/lib/modelStats";
import { formatRunTimestamp } from "@/lib/timestamp";
import { buildRemoteTrackSpecs } from "@/lib/remoteTrackSpec";
import type { InferenceConfig } from "@/stores/inferenceStore";

/** A `TrackJobSpec` with the fields the worker fills in itself stripped — see `TrainJobSpec.post_inference`'s doc. */
function toPostInferenceEntry(
  trackSpec: TrackJobSpec,
): Omit<TrackJobSpec, "type" | "data_path" | "model_paths"> {
  const entry: Partial<TrackJobSpec> = { ...trackSpec };
  delete entry.type;
  delete entry.data_path;
  delete entry.model_paths;
  return entry;
}

/**
 * Builds a worker-file train job's spec — always path-mode (`labels_path`,
 * never `labels_content`: the file already lives on the worker, so there's
 * nothing to embed). `configs` is sorted into pipeline order via
 * `getConfigSlots(modelType)`, matching `submitJobsOn`'s expectation for a
 * split multi-model run (`config_contents[i]` trains `model_types[i]`).
 *
 * `postInference`, when given, becomes `post_inference` — stripped of the
 * fields the worker fills in once training finishes (PR5w) — so the worker
 * chains it itself even if this app closes before training completes.
 */
export function buildLauncherTrainSpec(input: {
  labels: Labels;
  labelsPath: string;
  /**
   * Base64 `.slp` bytes to send as `labels_content`, alongside `labelsPath`
   * — set when `workerLabels.ts`'s `checkWorkerFileVideos` found one or more
   * of `labels`' videos only via a path rule or next to the `.slp` (its
   * recorded path isn't one the worker can open), via `needsLabelsRepoint`/
   * `videoChecksToVisibility` + `remoteLabelsPayload.ts`'s
   * `buildRemoteLabelsPayload`. `labelsPath` is still sent alongside it so
   * the worker's job list shows this job under the original file's name
   * while queued; sleap-connect's `_materialize_labels_content` overwrites
   * `spec.labels_path` to its own materialized temp file once the job
   * actually starts running, so this only matters pre-run, but costs
   * nothing to include. Omitted (no `labels_content` key at all) when falsy.
   */
  labelsContent?: string | null;
  modelType: ModelType;
  configs: ConfigFile[];
  postInference: InferenceConfig | null;
  project: JobProject;
}): TrainJobSpec {
  const { labels, labelsPath, labelsContent, modelType, configs, postInference, project } = input;
  const slots = getConfigSlots(modelType);
  const orderedConfigs = slots
    .map((slot) => configs.find((c) => c.slot === slot))
    .filter((c): c is ConfigFile => !!c);

  // Shared across every model below so a split multi-model pipeline's run
  // names all carry the exact same timestamp — see resolveRemoteRunName's
  // own doc for why that matters.
  const runTimestamp = formatRunTimestamp();
  const detectedChannels = detectVideoChannels(labels);

  const spec: TrainJobSpec = {
    type: "train",
    config_contents: orderedConfigs.map((c) =>
      applyHyperparamsToYaml(
        c.content,
        {
          ...c.hyperparams,
          runName: resolveRemoteRunName(c.hyperparams, c.modelType, labels, { runTimestamp }),
        },
        c.checkpointPath,
        resolveRemoteMaxStride(c.hyperparams, labels),
        resolveInputChannels(c.hyperparams.colorMode, detectedChannels),
      ),
    ),
    model_types: orderedConfigs.map((c) => c.modelType),
    labels_path: labelsPath,
    project,
  };

  if (labelsContent) spec.labels_content = labelsContent;

  if (postInference) {
    const trackSpecs = buildRemoteTrackSpecs(postInference, {
      dataPath: labelsPath,
      pathMappings: {},
      videoFrameCounts: labels.videos.map((v) => v.shape?.[0] ?? 0),
      // Neither a "current frame" nor a "current video" exists for a
      // worker-file launch (design §4.3's target list drops those options
      // for exactly this reason) — 0 is never actually read by any target
      // the wizard exposes.
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    });
    spec.post_inference = trackSpecs.map(toPostInferenceEntry);
  }

  return spec;
}

/**
 * Builds the track job spec(s) for the "Run inference" row action on an
 * already-finished training run — `modelDirs` are the run's own sibling
 * jobs' `result.model_dir`, already known (unlike `buildLauncherTrainSpec`'s
 * `post_inference`, which the worker fills in later because training hasn't
 * happened yet), so this submits a plain, standalone track job via
 * `submitJobsOn` rather than chaining.
 */
export function buildRunInferenceSpecs(
  labelsPath: string,
  modelDirs: string[],
  config: InferenceConfig,
  labels: Labels,
): TrackJobSpec[] {
  return buildRemoteTrackSpecs(
    { ...config, modelPaths: modelDirs },
    {
      dataPath: labelsPath,
      pathMappings: {},
      videoFrameCounts: labels.videos.map((v) => v.shape?.[0] ?? 0),
      currentFrameIdx: 0,
      activeVideoFrameCount: 0,
    },
  );
}

/** Reverses `slotToHeadType`'s forward mapping (trainingProfiles.ts) for the head-type sets `getConfigSlots` can actually produce. A `top_down_id` run's two configs carry the exact same head types a `top_down` run's do (slotToHeadType special-cases "centroid"/"centered_instance" before ever consulting `modelType`), so that pair is irreducibly ambiguous — it resolves to the more common `top_down`. */
const HEAD_TYPES_TO_MODEL_TYPE: Array<{ headTypes: string[]; modelType: ModelType }> = [
  { headTypes: ["centroid", "centered_instance"], modelType: "top_down" },
  { headTypes: ["single_instance"], modelType: "single_animal" },
  { headTypes: ["bottomup"], modelType: "bottom_up" },
  { headTypes: ["multi_class_bottomup"], modelType: "bottom_up_id" },
  { headTypes: ["multi_class_topdown"], modelType: "top_down_id" },
];

/**
 * Reverses `slotToHeadType` from a run's ordered head-type list (one per
 * sibling job, `run.index` order) to the pipeline `ModelType` — shared by
 * `seedFromJobSpec` (below) and the launcher wizard's Inference flow, which
 * uses it only to satisfy `buildPostTrainingInferenceConfig`'s `modelType`
 * param for its (unread by `buildRemoteTrackSpecs`) `pipeline` field, so a
 * `null`/fallback guess there is harmless.
 */
export function inferModelType(headTypes: string[]): ModelType | null {
  const match = HEAD_TYPES_TO_MODEL_TYPE.find(
    (m) => m.headTypes.length === headTypes.length && m.headTypes.every((h, i) => h === headTypes[i]),
  );
  return match?.modelType ?? null;
}

/**
 * Reconstructs `{modelType, configs}` from a train run's sibling job specs
 * for "Run again" (NewJobWizard row action, PR5b) — the caller gathers the
 * siblings (`listJobs` + `jobDetail`, grouped by `run.id`, ordered by
 * `run.index`) and passes one aggregate spec whose `config_contents[i]`/
 * `model_types[i]` is sibling i's own single-model YAML/head type (each job
 * in a split multi-model run carries only its own model — see
 * `isMultiModelTrainSpec`'s splitting in `connectStore.ts`).
 *
 * `null` when `model_types` doesn't match any pipeline shape this app
 * recognizes (see {@link HEAD_TYPES_TO_MODEL_TYPE}'s doc on `top_down_id`'s
 * ambiguity), or when none of the YAMLs parse.
 */
export function seedFromJobSpec(
  spec: Pick<TrainJobSpec, "config_contents" | "model_types">,
): { modelType: ModelType; configs: ConfigFile[] } | null {
  const modelType = inferModelType(spec.model_types);
  if (!modelType) return null;

  const slots = getConfigSlots(modelType);
  const { parseYamlConfig } = useTrainingStore.getState();
  const configs: ConfigFile[] = [];
  for (let i = 0; i < spec.config_contents.length; i++) {
    const slot = slots[i] ?? slots[slots.length - 1] ?? "config";
    const parsed = parseYamlConfig(spec.config_contents[i], `${slot}.yaml`, slot);
    if (parsed) configs.push(parsed);
  }
  if (configs.length === 0) return null;
  return { modelType, configs };
}
