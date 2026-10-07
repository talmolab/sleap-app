/**
 * LIVE round-engine inference: one round's revisit-sample prediction against a
 * real sleap-nn install and real trained top-down models, end to end through
 * the app's own pieces — no training.
 *
 *   buildPostTrainingInferenceConfig + explicitFrames → buildInferenceArgs
 *   → `sleap-nn predict` on 5 frames of the raw video → loadAndMergePredictionBytes
 *   (skip hand-labeled frames) → onPredictionsMerged → buildRoundQueue
 *
 * Opt-in (it spawns sleap-nn and takes a few seconds): set SLEAP_AL_LIVE=1. It
 * also needs the local demo models + the sibling sleap-io.js test video.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { Labels, LabeledFrame, Instance, Skeleton, Video, loadSlp } from "@talmolab/sleap-io.js";
import { buildPostTrainingInferenceConfig } from "@/stores/trainingStore";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { loadAndMergePredictionBytes, onPredictionsMerged } from "@/stores/inferenceStore";
import { buildRoundQueue, videoKey } from "@/lib/activeLearning/roundEngine";
import { frameKey } from "@/lib/activeLearning/reviewQueue";
import { useAppStore } from "@/stores/appStore";

const HOME = process.env.HOME ?? "";
const MODELS = path.join(HOME, "work/phase3-demo/models");
const CENTROID = path.join(MODELS, "centroid_20260727200401.");
const CENTERED = path.join(MODELS, "centered_instance_20260727200439.");
const VIDEO = path.join(HOME, "work/sleap-io.js/tests/data/videos/centered_pair_low_quality.mp4");
const SLEAP_NN = path.join(HOME, ".local/bin/sleap-nn");

const enabled =
  process.env.SLEAP_AL_LIVE === "1" &&
  [CENTROID, CENTERED, VIDEO, SLEAP_NN].every((p) => fs.existsSync(p));

describe.skipIf(!enabled)("round inference against real sleap-nn (SLEAP_AL_LIVE=1)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("predicts the explicit frames, skips the hand-labeled one, and queues only this round's frames", async () => {
    const skeleton = new Skeleton({ nodes: ["head", "thorax"], name: "fly" });
    const video = new Video({ filename: VIDEO, backendMetadata: { shape: [1100, 384, 384, 3] }, openBackend: false });
    const handLabeled = new Instance({
      skeleton,
      points: [
        { xy: [100, 100], visible: true, complete: true, name: "head" },
        { xy: [110, 110], visible: true, complete: true, name: "thorax" },
      ],
    });
    const labels = new Labels({
      videos: [video],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video, frameIdx: 10, instances: [handLabeled] })],
    });
    useAppStore.setState({ labels, video, skeleton, projectLoaded: true });

    // The round's job for this video: a revisit sample of explicit frames,
    // deliberately including the hand-labeled frame 10.
    const frames = [10, 120, 400, 700, 1000];
    const cfg = buildPostTrainingInferenceConfig({
      modelType: "top_down",
      modelPaths: [CENTROID, CENTERED],
      inferenceTarget: "random_video",
      videoIndex: 0,
      skipUserLabeled: true,
      existingPredictions: "replace",
    });
    cfg.explicitFrames = frames;
    cfg.device = "cpu";

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-live-")), "pred.slp");
    // As backend.runInference does for a single-video run: --data_path is the
    // video file itself, --video_index dropped, the explicit frames as --frames.
    const args = buildInferenceArgs(cfg, {
      dataPath: VIDEO,
      outputPath: out,
      sampledFrames: cfg.explicitFrames,
      suppressVideoIndex: true,
      subcommand: "predict",
    });
    expect(args).toContain("--frames");
    expect(args[args.indexOf("--frames") + 1]).toBe(frames.join(","));

    const run = spawnSync(SLEAP_NN, args, { encoding: "utf8", timeout: 240_000 });
    expect(run.status, (run.stderr ?? "").slice(-2000)).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    // The raw output DOES hold frame 10 — so the skip below is doing real work.
    const raw = await loadSlp(new Uint8Array(fs.readFileSync(out)), { openVideos: false, h5: { filenameHint: out } });
    expect(raw.labeledFrames.map((lf) => lf.frameIdx).sort((a, b) => a - b)).toEqual(frames);

    const merged = new Set<string>();
    const unsubscribe = onPredictionsMerged((preds) => {
      for (const lf of preds.labeledFrames) {
        if (videoKey(lf.video) === videoKey(video) && lf.hasPredictedInstances) {
          merged.add(frameKey(0, lf.frameIdx));
        }
      }
    });
    try {
      await loadAndMergePredictionBytes(new Uint8Array(fs.readFileSync(out)), out, "replace", false, {
        skipUserLabeledFrames: true,
      });
    } finally {
      unsubscribe();
    }

    const live = useAppStore.getState().labels!;
    // sleap-nn predicts frame 10 regardless (it ignores --exclude_user_labeled
    // on a raw video); the merge must have dropped it.
    expect(merged.has(frameKey(0, 10))).toBe(false);
    const f10 = live.find({ video, frameIdx: 10 })[0];
    expect(f10.predictedInstances.length).toBe(0);
    expect(f10.userInstances.length).toBe(1);
    // The other sampled frames came back with predictions (two flies each).
    for (const f of frames.slice(1)) expect(merged.has(frameKey(0, f))).toBe(true);

    // The round's queue only draws from this round's frames; threshold 1.0 so
    // the (confident) real predictions all qualify, budget caps it.
    const queue = buildRoundQueue(live, merged, { scoreThreshold: 1.0, reviewBudget: 3, spreadAcrossVideos: true });
    expect(queue.length).toBe(3);
    expect(queue.every((it) => frames.slice(1).includes(it.frameIdx))).toBe(true);
    const worst = queue.map((it) => it.worstScore);
    expect([...worst].sort((a, b) => a - b)).toEqual(worst);
  }, 300_000);
});
