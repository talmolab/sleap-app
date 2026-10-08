/**
 * The continuous active-learning loop: correct → retrain → predict → correct.
 *
 * Phase 2 hands round 1 to the Training panel, because that's where the pose
 * pipeline gets chosen. From then on a round runs by itself:
 *
 *   1. **Retrain** (`advanceRound`). Save the project (training reads the .slp
 *      from disk), rebuild the previous round's training configs from its own
 *      model folders and fine-tune from its best checkpoint, then start a local
 *      run tagged with the new round.
 *   2. **Predict** (`runRoundInference`, fired when that run completes).
 *      Videos no round has predicted yet go first, in full. Videos an earlier
 *      round covered get a fresh spread sample of unlabeled frames. Frames
 *      labeled by hand are always skipped.
 *   3. **Review** (`offerReview`). Build the round's queue, with the worst
 *      keypoints first, capped and spread across videos, and only from frames
 *      THIS round predicted. Old predictions the user skipped don't come back.
 *      Then start the sweep if the user is idle, or badge the Correct tab.
 *   4. When the sweep is finished, the engine hook starts step 1 again.
 *
 * The pure planning helpers are exported for tests. The orchestration drives
 * the existing stores; it only coordinates, so every step still shows up
 * through the usual training/inference progress bars.
 */

import type { Labels, Video } from "@talmolab/sleap-io.js";
import yaml from "js-yaml";
import {
  useActiveLearningStore,
  roundStatus,
  lastTrainedRound,
  type RoundRecord,
} from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import {
  useTrainingStore,
  getConfigSlots,
  buildPostTrainingInferenceConfig,
  type ConfigFile,
} from "@/stores/trainingStore";
import { useInferenceStore, onPredictionsMerged } from "@/stores/inferenceStore";
import type { MineConfig } from "./config";
import { buildReviewQueue, frameKey, spreadAcrossVideos, type ReviewItem } from "./reviewQueue";
import { startNextRound, type NextRoundOutcome } from "./loopRound";
import { videoBasename } from "@/lib/videoFilter";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { toast } from "@/lib/notify";
import { isTauri } from "@/platform";

// ── Planning (pure) ──────────────────────────────────────────────────────────

/** Stable identity for a video across sessions/machines: its file's basename. */
export function videoKey(video: Video): string {
  return videoBasename(video.filename);
}

/** Frames of `video` that are labeled by hand (user instances or negative). */
export function handLabeledFrames(labels: Labels, video: Video): Set<number> {
  const out = new Set<number>();
  for (const lf of labels.labeledFrames) {
    if (lf.video === video && (lf.hasUserInstances || lf.isNegative)) out.add(lf.frameIdx);
  }
  return out;
}

/**
 * Up to `k` frames of `0..n-1` minus `exclude`, spread evenly: the candidates
 * are cut into `k` equal-width bins and one random frame is taken per bin, so
 * the sample covers the whole video without the aliasing a fixed stride risks.
 * Returns every candidate (ascending) when there are no more than `k`.
 */
export function spreadSample(
  n: number,
  exclude: ReadonlySet<number>,
  k: number,
  rng: () => number = Math.random,
): number[] {
  if (k <= 0 || n <= 0) return [];
  const candidates: number[] = [];
  for (let f = 0; f < n; f++) if (!exclude.has(f)) candidates.push(f);
  if (candidates.length <= k) return candidates;
  const out: number[] = [];
  const width = candidates.length / k;
  for (let b = 0; b < k; b++) {
    const lo = Math.floor(b * width);
    const hi = Math.max(lo + 1, Math.floor((b + 1) * width));
    out.push(candidates[lo + Math.floor(rng() * (hi - lo))]);
  }
  return out;
}

/** What one round predicts: whole new videos first, then revisit samples. */
export interface RoundInferencePlan {
  /** Videos (indices into `labels.videos`) no round has predicted yet. */
  newVideos: number[];
  /** Earlier videos: a spread sample of their unlabeled frames each. */
  revisits: { videoIdx: number; frames: number[] }[];
}

export function planRoundInference(
  labels: Labels,
  predictedVideos: readonly string[],
  revisitFrames: number,
  rng: () => number = Math.random,
): RoundInferencePlan {
  const predicted = new Set(predictedVideos);
  const plan: RoundInferencePlan = { newVideos: [], revisits: [] };
  labels.videos.forEach((video, videoIdx) => {
    const n = video.shape?.[0] ?? 0;
    // A video of unknown length can't be predicted or sampled meaningfully.
    if (n <= 0) return;
    if (!predicted.has(videoKey(video))) {
      plan.newVideos.push(videoIdx);
    } else if (revisitFrames > 0) {
      const frames = spreadSample(n, handLabeledFrames(labels, video), revisitFrames, rng);
      if (frames.length > 0) plan.revisits.push({ videoIdx, frames });
    }
  });
  return plan;
}

export function planIsEmpty(plan: RoundInferencePlan): boolean {
  return plan.newVideos.length === 0 && plan.revisits.length === 0;
}

/**
 * A round's review queue: worst keypoint first, only from the frames this
 * round predicted, capped at the budget, and spread across videos when
 * configured.
 */
export function buildRoundQueue(
  labels: Labels,
  frames: ReadonlySet<string>,
  mine: Pick<MineConfig, "scoreThreshold" | "reviewBudget" | "spreadAcrossVideos">,
): ReviewItem[] {
  const all = buildReviewQueue(labels, { scoreThreshold: mine.scoreThreshold, frames });
  return mine.spreadAcrossVideos
    ? spreadAcrossVideos(all, mine.reviewBudget)
    : all.slice(0, Math.max(0, mine.reviewBudget));
}

// ── Retraining configs (I/O, injectable for tests) ───────────────────────────

export interface RetrainDeps {
  readText(path: string): Promise<string>;
  /** Full path of the checkpoint to fine-tune from in a run dir, or null. */
  findCheckpoint(runDir: string): Promise<string | null>;
  parseYamlConfig(text: string, filename: string, slot: string, checkpointPath: string | null): ConfigFile | null;
}

async function defaultRetrainDeps(): Promise<RetrainDeps> {
  const { findFineTuneCheckpoint } = await import("@/lib/modelDiscovery");
  return {
    async readText(path) {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      return readTextFile(path);
    },
    findCheckpoint: (dir) => findFineTuneCheckpoint(dir),
    parseYamlConfig: (text, filename, slot, ckpt) =>
      useTrainingStore.getState().parseYamlConfig(text, filename, slot, ckpt),
  };
}

/**
 * The backbone input channel count a trained `training_config.yaml` records
 * (the resolved `in_channels`), or null if it can't be read.
 */
export function trainedInChannels(yamlText: string): number | null {
  try {
    const doc = yaml.load(yamlText) as {
      model_config?: { backbone_config?: Record<string, { in_channels?: unknown } | null> };
    } | null;
    for (const bb of Object.values(doc?.model_config?.backbone_config ?? {})) {
      if (bb && typeof bb.in_channels === "number") return bb.in_channels;
    }
  } catch {
    // Unparseable — leave channel handling to the launch's own resolution.
  }
  return null;
}

function joinDir(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]+$/, "")}${sep}${name}`;
}

/**
 * Rebuild a finished round's training configs from its model folders, ready to
 * train the next round. A trained run's `training_config.yaml` is exactly the
 * recipe that produced it, so the next round uses the same pipeline and
 * hyperparameters. With `fineTune` it starts from that run's best checkpoint.
 * The run name is cleared, so the new run gets its own timestamped folder.
 * Returns an error message instead of configs when a folder can't be read.
 */
export async function prepareRetrainConfigs(
  prev: RoundRecord,
  fineTune: boolean,
  deps?: RetrainDeps,
): Promise<ConfigFile[] | string> {
  const d = deps ?? (await defaultRetrainDeps());
  const out: ConfigFile[] = [];
  for (const { slot, dir } of prev.models) {
    let text: string;
    try {
      text = await d.readText(joinDir(dir, "training_config.yaml"));
    } catch {
      return `Couldn't read round ${prev.round}'s training_config.yaml in ${dir}.`;
    }
    const ckpt = fineTune ? await d.findCheckpoint(dir) : null;
    const cf = d.parseYamlConfig(text, "training_config.yaml", slot, ckpt);
    if (!cf) return `Round ${prev.round}'s ${slot} config in ${dir} couldn't be parsed.`;
    // Fine-tuning loads the old weights, so the input layer must keep the
    // channel count they were trained with. Pin it explicitly: under "auto"
    // the launch re-derives it from the videos and falls back to 1 when a
    // video's shape isn't known yet — a mismatch sleap-nn refuses to load.
    const channels = ckpt ? trainedInChannels(text) : null;
    const colorMode =
      channels === 3 ? "rgb" : channels === 1 ? "grayscale" : cf.hyperparams.colorMode;
    out.push({
      ...cf,
      checkpointPath: ckpt,
      hyperparams: {
        ...cf.hyperparams,
        colorMode,
        trainingMode: ckpt ? "finetune" : "reuse_config",
        runName: "",
      },
    });
  }
  return out;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Whether the loop can start a review sweep on its own right now. */
export function isIdleForReview(labelingMode: string): boolean {
  return labelingMode === "select";
}

/**
 * Advance the loop one round. When an earlier round has a trained model (and
 * this is the desktop app), retrain by itself: save, fine-tune from that model,
 * start. Otherwise fall back to the Training-panel hand-off, where round 1's
 * pipeline gets chosen.
 */
export async function advanceRound(): Promise<NextRoundOutcome> {
  const al = useActiveLearningStore.getState();
  const config = al.config;
  const status = roundStatus(al);
  if (!config || status.maxRounds === null) {
    return { ok: false, reason: "No active-learning workflow is loaded." };
  }
  if (!status.canAdvance) {
    return {
      ok: false,
      reason: `Round ${status.round} of ${status.maxRounds} — the configured loop is complete. Raise loop.maxRounds to keep going.`,
    };
  }
  const prev = lastTrainedRound(al);
  if (!prev || !isTauri) return startNextRound();

  const t = useTrainingStore.getState();
  if (t.status === "running") return { ok: false, reason: "A training run is already in progress." };

  const app = useAppStore.getState();
  if (app.labelingMode === "correct") app.exitCorrectMode();
  app.setPendingReview(null);
  al.setPendingQueue(null);

  // Training reads the saved .slp, so the corrections have to be on disk first.
  if (app.hasChanges && app.labels) {
    const { saveProjectAsSlp } = await import("@/lib/saveProject");
    await saveProjectAsSlp(app.labels, app.filename ?? undefined);
    if (useAppStore.getState().hasChanges) {
      return { ok: false, reason: "Couldn't save the project, so the next round wasn't started." };
    }
  }

  const configs = await prepareRetrainConfigs(prev, config.loop.fineTune);
  if (typeof configs === "string") return { ok: false, reason: configs };

  if (!al.nextRound({ phase: "mine" })) return { ok: false, reason: "The loop could not advance." };
  const round = useActiveLearningStore.getState().round;

  t.setConfig("modelType", prev.modelType as typeof t.config.modelType);
  t.setConfig("trainingLabelsPath", "");
  for (const slot of getConfigSlots(t.config.modelType)) t.removeConfigFile(slot);
  for (const cf of configs) t.addConfigFile(cf);

  useActiveLearningStore.getState().setStage("training");
  const fineTuned = configs.every((c) => c.hyperparams.trainingMode === "finetune");
  toast.info(
    `Round ${round}: training on your corrections` +
      (fineTuned ? ` (fine-tuning round ${prev.round}'s model).` : "."),
  );
  // Long-running: the engine hook takes over when the run completes.
  void useTrainingStore.getState().startTraining({
    inferenceTarget: "nothing",
    skipUserLabeled: true,
    activeLearningRound: round,
  });
  return { ok: true, round };
}

/**
 * A loop round's training run finished: record its models, then predict.
 * Called once per completed run by the engine hook.
 */
export async function onRoundTrainingCompleted(round: number): Promise<void> {
  const t = useTrainingStore.getState();
  const slots = getConfigSlots(t.config.modelType);
  const dirs = t.modelOutputDirs;
  const models = slots.map((slot, i) => ({ slot, dir: dirs[i] })).filter((m) => !!m.dir);
  const al = useActiveLearningStore.getState();
  if (models.length !== slots.length) {
    al.setStage("idle");
    toast.error(`Round ${round} finished, but its trained model folders weren't reported — run inference from the Inference panel.`);
    return;
  }
  al.recordTraining({
    round,
    modelType: t.config.modelType,
    models,
    trainedAt: new Date().toISOString(),
    fineTuned: t.config.configs.some((c) => c.hyperparams.trainingMode === "finetune"),
  });
  markLoopStateChanged();
  await runRoundInference(round);
}

/**
 * Predict for a round with that round's model: new videos in full, then the
 * revisit samples. Also used on its own ("Predict new videos now") when videos
 * are added between rounds.
 */
export async function runRoundInference(round: number): Promise<void> {
  const al = useActiveLearningStore.getState();
  const config = al.config;
  const rec = al.history.find((r) => r.round === round);
  const labels = useAppStore.getState().labels;
  if (!config || !rec || !labels) return;

  const plan = planRoundInference(labels, al.predictedVideos, config.mine.revisitFrames);
  if (planIsEmpty(plan)) {
    al.setStage("idle");
    toast.info("Nothing new to predict — add videos to the project to keep the loop going.");
    return;
  }

  al.setStage("predicting");
  const byBasename = new Map(labels.videos.map((v, i) => [videoKey(v), i] as const));
  const merged = new Set<string>();
  const unsubscribe = onPredictionsMerged((predictions) => {
    for (const lf of predictions.labeledFrames) {
      const vi = byBasename.get(videoKey(lf.video));
      if (vi !== undefined && lf.hasPredictedInstances) merged.add(frameKey(vi, lf.frameIdx));
    }
  });

  const jobs: { videoIdx: number; frames: number[] | null }[] = [
    ...plan.newVideos.map((videoIdx) => ({ videoIdx, frames: null })),
    ...plan.revisits.map((r) => ({ videoIdx: r.videoIdx, frames: r.frames })),
  ];
  const modelPaths = rec.models.map((m) => m.dir);
  let predictedVideos = 0;
  let failed: string | null = null;
  try {
    for (let k = 0; k < jobs.length; k++) {
      const job = jobs[k];
      useActiveLearningStore.getState().setStageProgress({ done: k, total: jobs.length });
      const cfg = buildPostTrainingInferenceConfig({
        modelType: rec.modelType as Parameters<typeof buildPostTrainingInferenceConfig>[0]["modelType"],
        modelPaths,
        inferenceTarget: job.frames ? "random_video" : "video",
        videoIndex: job.videoIdx,
        skipUserLabeled: true,
        existingPredictions: "replace",
      });
      if (job.frames) cfg.explicitFrames = job.frames;
      await useInferenceStore.getState().startInference(cfg);
      const st = useInferenceStore.getState();
      if (st.status === "error" || st.status === "cancelled") {
        failed = st.status === "cancelled" ? "cancelled" : st.error ?? "inference failed";
        break;
      }
      predictedVideos += 1;
      if (!job.frames) {
        const video = labels.videos[job.videoIdx];
        if (video) useActiveLearningStore.getState().markVideosPredicted([videoKey(video)]);
      }
    }
  } finally {
    unsubscribe();
    useActiveLearningStore.getState().setStageProgress(null);
  }

  useActiveLearningStore.getState().updateRound(round, {
    predicted: { videos: predictedVideos, frames: merged.size },
  });
  markLoopStateChanged();

  if (failed) {
    useActiveLearningStore.getState().setStage("idle");
    toast.error(`Round ${round}: prediction stopped (${failed}). Anything already predicted was kept.`);
    if (merged.size === 0) return;
  }

  const live = useAppStore.getState().labels;
  if (!live) return;
  const queue = buildRoundQueue(live, merged, config.mine);
  useActiveLearningStore.getState().updateRound(round, { queued: queue.length });
  if (queue.length === 0) {
    useActiveLearningStore.getState().setStage("idle");
    toast.success(
      `Round ${round}: ${merged.size} frame(s) predicted and every keypoint scored above ${config.mine.scoreThreshold} — nothing to review.`,
    );
    return;
  }
  const total = buildReviewQueue(live, { frames: merged }).length;
  offerReview(round, queue, total);
}

/**
 * Hand a round's queue to the user: start the sweep if they're idle and the
 * workflow asks for it, otherwise keep it ready behind the Correct tab badge.
 */
export function offerReview(round: number, queue: ReviewItem[], total: number): void {
  const al = useActiveLearningStore.getState();
  const app = useAppStore.getState();
  const config = al.config;
  if (!config) return;
  al.setStage("reviewing");
  if (config.mine.autoReview && isIdleForReview(app.labelingMode)) {
    al.setPendingQueue(null);
    app.enterCorrectMode({ queue, scoreThreshold: config.mine.scoreThreshold });
    toast.info(
      `Round ${round}: reviewing the ${queue.length} least-confident prediction(s). Drag to fix, Space to accept.`,
    );
    return;
  }
  al.setPendingQueue(queue);
  app.setPendingReview({ flagged: queue.length, total });
}

/**
 * The loop's progress lives in the project's provenance; mark the project
 * changed (and the autosave structural, since provenance isn't frame data).
 */
function markLoopStateChanged(): void {
  useAppStore.getState().markChanged();
  dirtyFrameTracker.markStructural();
}
