/**
 * The continuous active-learning loop (rounds ≥ 1): config fields, persisted
 * loop state, the round's inference plan, the budgeted + spread review queue,
 * retrain-config rebuilding, and review hand-off.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import {
  DEFAULT_ACTIVE_LEARNING_CONFIG,
  normalizeActiveLearningConfig,
  validateActiveLearningConfig,
} from "@/lib/activeLearning/config";
import {
  buildReviewQueue,
  frameKey,
  spreadAcrossVideos,
  type ReviewItem,
} from "@/lib/activeLearning/reviewQueue";
import {
  spreadSample,
  planRoundInference,
  planIsEmpty,
  buildRoundQueue,
  prepareRetrainConfigs,
  offerReview,
  videoKey,
  isIdleForReview,
} from "@/lib/activeLearning/roundEngine";
import { useActiveLearningStore, lastTrainedRound, type RoundRecord } from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import {
  syncActiveLearningProvenance,
  hydrateActiveLearningStore,
  readPersistedLoopState,
  AL_STATE_PROVENANCE_KEY,
} from "@/lib/activeLearning/persistence";
import type { ConfigFile } from "@/stores/trainingStore";

const NODES = ["head", "body", "tail"];

function skel(): Skeleton {
  return new Skeleton({ nodes: [...NODES], name: "s" });
}

function video(name: string, n: number): Video {
  return new Video({ filename: `/data/${name}`, backendMetadata: { shape: [n, 64, 64, 1] }, openBackend: false });
}

function predicted(sk: Skeleton, worst: number): PredictedInstance {
  return new PredictedInstance({
    skeleton: sk,
    points: sk.nodes.map((nd, i) => ({
      xy: [10 + i, 10 + i] as [number, number],
      visible: true,
      complete: true,
      name: nd.name,
      score: i === 0 ? worst : 0.95,
    })),
    score: 0.9,
  });
}

function userInstance(sk: Skeleton): Instance {
  const inst = Instance.empty({ skeleton: sk });
  for (let i = 0; i < sk.nodes.length; i++) {
    inst.points[i].xy = [5, 5];
    inst.points[i].visible = true;
  }
  return inst;
}

/** Fixed-sequence rng so samples are reproducible. */
function seqRng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("loop config", () => {
  it("defaults the new round settings", () => {
    const d = DEFAULT_ACTIVE_LEARNING_CONFIG;
    expect(d.loop.autoRetrain).toBe(true);
    expect(d.loop.fineTune).toBe(true);
    expect(d.mine.reviewBudget).toBe(50);
    expect(d.mine.spreadAcrossVideos).toBe(true);
    expect(d.mine.revisitFrames).toBe(200);
    expect(d.mine.autoReview).toBe(true);
  });

  it("fills them in for an older YAML that lacks them, and honors overrides", () => {
    const old = normalizeActiveLearningConfig({ loop: { maxRounds: 3 }, mine: { scoreThreshold: 0.4 } });
    expect(old.loop.autoRetrain).toBe(true);
    expect(old.mine.reviewBudget).toBe(50);
    const custom = normalizeActiveLearningConfig({
      loop: { autoRetrain: false, fineTune: false },
      mine: { reviewBudget: 10, spreadAcrossVideos: false, revisitFrames: 0, autoReview: false },
    });
    expect(custom.loop).toMatchObject({ autoRetrain: false, fineTune: false });
    expect(custom.mine).toMatchObject({ reviewBudget: 10, spreadAcrossVideos: false, revisitFrames: 0, autoReview: false });
  });

  it("rejects out-of-range round settings", () => {
    const bad = normalizeActiveLearningConfig({ mine: { reviewBudget: 0, revisitFrames: -1, scoreThreshold: 1.5 } });
    const v = validateActiveLearningConfig(bad, []);
    expect(v.errors.some((e) => e.includes("reviewBudget"))).toBe(true);
    expect(v.errors.some((e) => e.includes("revisitFrames"))).toBe(true);
    expect(v.errors.some((e) => e.includes("scoreThreshold"))).toBe(true);
  });
});

describe("loop state in the store + .slp provenance", () => {
  beforeEach(() => {
    useActiveLearningStore.getState().clear();
  });

  const rec = (round: number): RoundRecord => ({
    round,
    modelType: "top_down",
    models: [
      { slot: "centroid", dir: `/m/r${round}.centroid` },
      { slot: "centered_instance", dir: `/m/r${round}.ci` },
    ],
    trainedAt: "2026-10-06T00:00:00.000Z",
    fineTuned: round > 1,
  });

  it("records rounds, replacing a re-recorded one, and finds the latest", () => {
    const al = useActiveLearningStore.getState();
    al.setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
    al.recordTraining(rec(1));
    al.recordTraining(rec(2));
    al.recordTraining({ ...rec(2), modelType: "bottom_up" });
    al.updateRound(2, { queued: 7 });
    const s = useActiveLearningStore.getState();
    expect(s.history.map((r) => r.round)).toEqual([1, 2]);
    expect(lastTrainedRound(s)).toMatchObject({ round: 2, modelType: "bottom_up", queued: 7 });
  });

  it("keeps progress when the workflow is EDITED, resets it when a new one is adopted", () => {
    const al = useActiveLearningStore.getState();
    al.setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
    al.recordTraining(rec(1));
    al.nextRound();
    al.setConfig({ ...DEFAULT_ACTIVE_LEARNING_CONFIG, loop: { ...DEFAULT_ACTIVE_LEARNING_CONFIG.loop, maxRounds: 9 } }, [], { keepProgress: true });
    expect(useActiveLearningStore.getState().round).toBe(2);
    expect(useActiveLearningStore.getState().history.length).toBe(1);
    al.setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
    expect(useActiveLearningStore.getState().round).toBe(1);
    expect(useActiveLearningStore.getState().history).toEqual([]);
  });

  it("round-trips round, history and predicted videos through provenance", () => {
    const al = useActiveLearningStore.getState();
    al.setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
    al.recordTraining(rec(1));
    al.nextRound({ phase: "mine" });
    al.markVideosPredicted(["a.mp4", "b.mp4", "a.mp4"]);
    const labels = new Labels({ skeletons: [skel()] });
    syncActiveLearningProvenance(labels);
    expect(labels.provenance[AL_STATE_PROVENANCE_KEY]).toBeTruthy();

    useActiveLearningStore.getState().clear();
    hydrateActiveLearningStore(labels);
    const s = useActiveLearningStore.getState();
    expect(s.round).toBe(2);
    expect(s.phase).toBe("mine");
    expect(s.history.map((r) => r.round)).toEqual([1]);
    expect(s.predictedVideos).toEqual(["a.mp4", "b.mp4"]);
    expect(s.stage).toBe("idle"); // runtime-only
  });

  it("drops malformed stored state instead of throwing", () => {
    expect(readPersistedLoopState("nope")).toEqual({});
    const r = readPersistedLoopState({
      round: 0,
      phase: "bogus",
      history: [{ round: 1, modelType: "x", models: [{ slot: "config", dir: "/d" }] }, { round: "2" }],
      predictedVideos: ["v.mp4", 3],
    });
    expect(r.round).toBeUndefined();
    expect(r.phase).toBeUndefined();
    expect(r.history?.length).toBe(1);
    expect(r.predictedVideos).toEqual(["v.mp4"]);
  });
});

describe("planning a round's inference", () => {
  it("spreadSample covers the range, skips excluded frames, and returns all when few", () => {
    const out = spreadSample(100, new Set([0, 1, 2, 3, 4]), 10, seqRng(3));
    expect(out.length).toBe(10);
    expect(new Set(out).size).toBe(10);
    expect(out.some((f) => f < 5)).toBe(false);
    expect(Math.min(...out)).toBeLessThan(20);
    expect(Math.max(...out)).toBeGreaterThan(85);
    expect(spreadSample(6, new Set([2]), 10)).toEqual([0, 1, 3, 4, 5]);
    expect(spreadSample(50, new Set(), 0)).toEqual([]);
  });

  it("predicts new videos in full and revisits earlier ones with unlabeled samples", () => {
    const sk = skel();
    const a = video("a.mp4", 1000);
    const b = video("b.mp4", 500);
    const unknown = new Video({ filename: "/data/c.mp4", openBackend: false });
    const labeledFrame = new LabeledFrame({ video: a, frameIdx: 7, instances: [userInstance(sk)] });
    const labels = new Labels({ videos: [a, b, unknown], skeletons: [sk], labeledFrames: [labeledFrame] });

    const plan = planRoundInference(labels, ["a.mp4"], 20, seqRng(5));
    expect(plan.newVideos).toEqual([1]); // b; c has no known length
    expect(plan.revisits).toHaveLength(1);
    expect(plan.revisits[0].videoIdx).toBe(0);
    expect(plan.revisits[0].frames).toHaveLength(20);
    expect(plan.revisits[0].frames).not.toContain(7); // hand-labeled
  });

  it("revisitFrames 0 means only new videos; nothing new is an empty plan", () => {
    const a = video("a.mp4", 100);
    const labels = new Labels({ videos: [a], skeletons: [skel()] });
    const plan = planRoundInference(labels, [videoKey(a)], 0);
    expect(planIsEmpty(plan)).toBe(true);
  });
});

describe("the round's review queue", () => {
  /** Three videos; v0 has many bad predictions, v1/v2 one each. */
  function threeVideoLabels() {
    const sk = skel();
    const vids = [video("v0.mp4", 100), video("v1.mp4", 100), video("v2.mp4", 100)];
    const frames: LabeledFrame[] = [];
    for (let f = 0; f < 6; f++) {
      frames.push(new LabeledFrame({ video: vids[0], frameIdx: f, instances: [predicted(sk, 0.01 + f * 0.01)] }));
    }
    frames.push(new LabeledFrame({ video: vids[1], frameIdx: 3, instances: [predicted(sk, 0.2)] }));
    frames.push(new LabeledFrame({ video: vids[2], frameIdx: 4, instances: [predicted(sk, 0.25)] }));
    // An OLD prediction (earlier round, skipped by the user) — not in this round's frames.
    frames.push(new LabeledFrame({ video: vids[2], frameIdx: 9, instances: [predicted(sk, 0.001)] }));
    return new Labels({ videos: vids, skeletons: [sk], labeledFrames: frames });
  }

  it("only considers frames the round predicted", () => {
    const labels = threeVideoLabels();
    const roundFrames = new Set([0, 1, 2, 3, 4, 5].map((f) => frameKey(0, f)).concat([frameKey(1, 3), frameKey(2, 4)]));
    const q = buildReviewQueue(labels, { scoreThreshold: 0.3, frames: roundFrames });
    expect(q.length).toBe(8);
    expect(q.some((it) => it.videoIdx === 2 && it.frameIdx === 9)).toBe(false);
  });

  it("spreads a budget so every video gets reviewed, worst-first order kept", () => {
    const labels = threeVideoLabels();
    const all = buildReviewQueue(labels, { scoreThreshold: 0.3 });
    const spread = spreadAcrossVideos(all, 4);
    expect(spread.length).toBe(4);
    expect(new Set(spread.map((i) => i.videoIdx))).toEqual(new Set([0, 1, 2]));
    const worst = spread.map((i) => i.worstScore);
    expect([...worst].sort((x, y) => x - y)).toEqual(worst);
    // Without spreading the 4 worst would ALL be from v0 / the stale v2 frame.
    expect(new Set(all.slice(0, 4).map((i) => i.videoIdx)).has(1)).toBe(false);
    // Budget a video can't use flows to the others.
    expect(spreadAcrossVideos(all, 100)).toEqual(all);
  });

  it("buildRoundQueue applies frames, threshold, budget and spread together", () => {
    const labels = threeVideoLabels();
    const roundFrames = new Set([0, 1, 2, 3, 4, 5].map((f) => frameKey(0, f)).concat([frameKey(1, 3)]));
    const q = buildRoundQueue(labels, roundFrames, { scoreThreshold: 0.3, reviewBudget: 3, spreadAcrossVideos: true });
    expect(q.length).toBe(3);
    expect(q.filter((i) => i.videoIdx === 1).length).toBe(1);
    const unspread = buildRoundQueue(labels, roundFrames, { scoreThreshold: 0.3, reviewBudget: 3, spreadAcrossVideos: false });
    expect(unspread.every((i) => i.videoIdx === 0)).toBe(true);
  });
});

describe("rebuilding the previous round's configs to retrain", () => {
  const prev: RoundRecord = {
    round: 1,
    modelType: "top_down",
    models: [
      { slot: "centroid", dir: "/proj/models/r1.centroid" },
      { slot: "centered_instance", dir: "/proj/models/r1.centered_instance" },
    ],
    trainedAt: "t",
    fineTuned: false,
  };
  const fakeConfig = (slot: string, ckpt: string | null): ConfigFile =>
    ({
      filename: "training_config.yaml",
      slot,
      checkpointPath: ckpt,
      hyperparams: { trainingMode: "reuse_config", runName: "260101_000000.centroid.n=40" },
    }) as unknown as ConfigFile;

  it("fine-tunes from each run's best checkpoint and clears the run name", async () => {
    const read: string[] = [];
    const out = await prepareRetrainConfigs(prev, true, {
      readText: async (p) => (read.push(p), "yaml"),
      findCheckpoint: async (dir) => `${dir}/best.ckpt`,
      parseYamlConfig: (_t, _f, slot, ckpt) => fakeConfig(slot, ckpt),
    });
    expect(typeof out).not.toBe("string");
    const cfgs = out as ConfigFile[];
    expect(read).toEqual([
      "/proj/models/r1.centroid/training_config.yaml",
      "/proj/models/r1.centered_instance/training_config.yaml",
    ]);
    expect(cfgs.map((c) => c.slot)).toEqual(["centroid", "centered_instance"]);
    expect(cfgs.every((c) => c.hyperparams.trainingMode === "finetune")).toBe(true);
    expect(cfgs[0].checkpointPath).toBe("/proj/models/r1.centroid/best.ckpt");
    expect(cfgs.every((c) => c.hyperparams.runName === "")).toBe(true);
  });

  it("trains from scratch when fine-tuning is off or no checkpoint exists", async () => {
    const off = (await prepareRetrainConfigs(prev, false, {
      readText: async () => "yaml",
      findCheckpoint: async () => "/never/used.ckpt",
      parseYamlConfig: (_t, _f, slot, ckpt) => fakeConfig(slot, ckpt),
    })) as ConfigFile[];
    expect(off.every((c) => c.hyperparams.trainingMode === "reuse_config" && c.checkpointPath === null)).toBe(true);
    const none = (await prepareRetrainConfigs(prev, true, {
      readText: async () => "yaml",
      findCheckpoint: async () => null,
      parseYamlConfig: (_t, _f, slot, ckpt) => fakeConfig(slot, ckpt),
    })) as ConfigFile[];
    expect(none.every((c) => c.hyperparams.trainingMode === "reuse_config")).toBe(true);
  });

  it("reports an unreadable model folder instead of throwing", async () => {
    const out = await prepareRetrainConfigs(prev, true, {
      readText: async () => {
        throw new Error("ENOENT");
      },
      findCheckpoint: async () => null,
      parseYamlConfig: () => null,
    });
    expect(typeof out).toBe("string");
    expect(out as string).toContain("r1.centroid");
  });
});

describe("handing a round's queue to the user", () => {
  const item = (videoIdx: number): ReviewItem => ({
    videoIdx,
    frameIdx: 0,
    instanceIdx: 0,
    worstScore: 0.1,
    worstNodeIdx: 0,
    meanScore: 0.5,
    instanceScore: 0.9,
    pointScores: [0.1, 0.9, 0.9],
    centroidXY: [1, 1],
  });

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useActiveLearningStore.getState().clear();
    useActiveLearningStore.getState().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
  });

  it("starts the sweep straight away when the user is idle", () => {
    expect(isIdleForReview("select")).toBe(true);
    offerReview(2, [item(0), item(1)], 10);
    const app = useAppStore.getState();
    expect(app.labelingMode).toBe("correct");
    expect(app.correctQueue.length).toBe(2);
    expect(app.correctScoreThreshold).toBe(DEFAULT_ACTIVE_LEARNING_CONFIG.mine.scoreThreshold);
    expect(useActiveLearningStore.getState().stage).toBe("reviewing");
    expect(useActiveLearningStore.getState().pendingQueue).toBeNull();
  });

  it("waits behind the badge while the user is mid-sweep", () => {
    useAppStore.getState().set("labelingMode", "keypointPass");
    offerReview(2, [item(0)], 10);
    expect(useAppStore.getState().labelingMode).toBe("keypointPass");
    expect(useAppStore.getState().pendingReview).toEqual({ flagged: 1, total: 10 });
    expect(useActiveLearningStore.getState().pendingQueue?.length).toBe(1);
  });

  it("only badges when autoReview is off", () => {
    useActiveLearningStore.getState().setConfig(
      { ...DEFAULT_ACTIVE_LEARNING_CONFIG, mine: { ...DEFAULT_ACTIVE_LEARNING_CONFIG.mine, autoReview: false } },
      [],
    );
    offerReview(1, [item(0)], 1);
    expect(useAppStore.getState().labelingMode).toBe("select");
    expect(useAppStore.getState().pendingReview).toEqual({ flagged: 1, total: 1 });
  });
});
