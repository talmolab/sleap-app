/**
 * Inference on a project with several skeletons (#99): models are matched to
 * project skeletons by node names, grouped into one run per skeleton, and each
 * run's predictions merge under its own skeleton only. Uses the mice + pellet
 * project (3-node mouse skeleton + 1-node pellet skeleton on one video).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  PredictedInstance,
  Skeleton,
  SuggestionFrame,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import {
  configForSkeletonRun,
  forgetFailedModelReads,
  remoteMixedFramesProblem,
  remoteSpecScope,
  runNeedsSkeletonCopy,
  skeletonsInUse,
  labelsForSkeleton,
  matchModelSkeleton,
  multiSkeletonRunProblem,
  parseModelInfo,
  pickModelsForSkeletons,
  pipelineForModels,
  planMultiSkeletonInference,
  remoteMultiSkeletonTargetProblem,
  runSpecsFromPlan,
  resolveSkeletonInferenceSettings,
  skeletonRunSettings,
  skeletonSettingsKey,
  DEFAULT_SKELETON_INFERENCE_SETTINGS,
  DEFAULT_SKELETON_RUN_SETTINGS,
  SKELETON_RUN_SETTING_KEYS,
  type ModelInfo,
} from "@/lib/multiSkeletonInference";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { buildRemoteTrackSpecs } from "@/lib/remoteTrackSpec";
import { needsSkeletonScopedMerge, resolvePredictionsSkeleton } from "@/lib/skeletonScopedMerge";
import { CommandContext } from "@/commands/CommandContext";
import { MergePredictions } from "@/commands/editCommands";
import { useAppStore } from "@/stores/appStore";
import type { InferenceConfig } from "@/stores/inferenceStore";
import { makeTwoSkeletonProject, makeDuplicateSkeletonProject, makeMouseSkeleton } from "./multiSkeletonFixture";

const MOUSE = ["head", "body", "tail"];
const PELLET = ["centroid"];

function model(path: string, headKey: string | null, nodeNames: string[] | null): ModelInfo {
  return { path, headKey, cropMode: "fixed", nodeNames };
}

const mouseCentroid = model("/m/mouse_centroid", "centroid", MOUSE);
const mouseCi = model("/m/mouse_ci", "centered_instance", MOUSE);
const pelletCentroid = model("/m/pellet_centroid", "centroid", PELLET);

describe("matching a model to a project skeleton by node names", () => {
  // The decision: a model belongs to the skeleton whose node names equal its own.
  it("matches the mouse and pellet models to their skeletons", () => {
    const { labels, mouse, pellet } = makeTwoSkeletonProject();
    expect(matchModelSkeleton(MOUSE, labels.skeletons)).toEqual({ ok: true, skeleton: mouse });
    expect(matchModelSkeleton(PELLET, labels.skeletons)).toEqual({ ok: true, skeleton: pellet });
  });

  // Node order doesn't matter: merging remaps points by name.
  it("ignores node order", () => {
    const { labels, mouse } = makeTwoSkeletonProject();
    expect(matchModelSkeleton(["tail", "head", "body"], labels.skeletons)).toEqual({ ok: true, skeleton: mouse });
  });

  // A model that matches no skeleton is refused with a reason naming what differs.
  it("refuses a model that matches none, naming the closest skeleton", () => {
    const { labels } = makeTwoSkeletonProject();
    const m = matchModelSkeleton(["head", "body", "nose"], labels.skeletons);
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.reason).toContain("don't match any project skeleton");
      expect(m.reason).toContain("Closest: mouse");
      expect(m.reason).toContain("missing tail");
      expect(m.reason).toContain("extra nose");
    }
  });

  // An unreadable config can't be matched — refused, not guessed.
  it("refuses a model whose skeleton couldn't be read", () => {
    const { labels } = makeTwoSkeletonProject();
    const m = matchModelSkeleton(null, labels.skeletons);
    expect(m.ok).toBe(false);
  });

  // Two different skeletons with the same node names: ambiguous, so refused.
  it("refuses when the names match two different skeletons", () => {
    const a = makeMouseSkeleton();
    const b = new Skeleton({ nodes: ["head", "body", "tail"], name: "mouse2" }); // no edges
    const m = matchModelSkeleton(MOUSE, [a, b]);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toContain("several project skeletons");
  });

  // Identical duplicate skeleton objects (old files) are one skeleton, not ambiguous.
  it("treats identical duplicate skeletons as one", () => {
    const { labels, a } = makeDuplicateSkeletonProject();
    expect(matchModelSkeleton(MOUSE, labels.skeletons)).toEqual({ ok: true, skeleton: a });
  });
});

describe("pipeline from one skeleton's models", () => {
  // sleap-nn picks the predictor from the models' heads; the app mirrors that.
  it("recognizes top-down, bottom-up, single-animal and a centroid model alone", () => {
    expect(pipelineForModels([mouseCentroid, mouseCi])).toBe("top-down");
    expect(pipelineForModels([mouseCi, mouseCentroid])).toBe("top-down");
    expect(pipelineForModels([model("/b", "bottomup", MOUSE)])).toBe("bottom-up");
    expect(pipelineForModels([model("/s", "single_instance", MOUSE)])).toBe("single-animal");
    expect(pipelineForModels([pelletCentroid])).toBe("centroid-only");
  });

  // Models that don't form a pipeline (e.g. two centroid models) give null.
  it("returns null for models that don't fit together", () => {
    expect(pipelineForModels([mouseCentroid, model("/c2", "centroid", MOUSE)])).toBeNull();
    expect(pipelineForModels([mouseCi])).toBeNull();
    expect(pipelineForModels([])).toBeNull();
  });
});

describe("the mice + pellet plan", () => {
  // The headline case: mouse top-down + pellet centroid → two runs, one per skeleton.
  it("groups models into one run per skeleton, in project order", () => {
    const { labels, mouse, pellet } = makeTwoSkeletonProject();
    const plan = planMultiSkeletonInference([pelletCentroid, mouseCentroid, mouseCi], labels.skeletons);
    expect(plan.problem).toBeNull();
    expect(plan.runs.map((r) => [r.skeleton, r.pipeline, r.modelPaths])).toEqual([
      [mouse, "top-down", ["/m/mouse_centroid", "/m/mouse_ci"]],
      [pellet, "centroid-only", ["/m/pellet_centroid"]],
    ]);
    expect(plan.models.map((v) => v.skeletonName)).toEqual(["pellet", "mouse", "mouse"]);
    expect(runSpecsFromPlan(plan)).toEqual([
      { skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/mouse_centroid", "/m/mouse_ci"], pipeline: "top-down" },
      { skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/pellet_centroid"], pipeline: "centroid-only" },
    ]);
  });

  // One refused model blocks Run (the user removes it), with its reason shown.
  it("blocks the run while a model matches no skeleton", () => {
    const { labels } = makeTwoSkeletonProject();
    const fly = model("/m/fly", "bottomup", ["thorax", "wingL", "wingR"]);
    const plan = planMultiSkeletonInference([mouseCentroid, mouseCi, fly], labels.skeletons);
    expect(plan.problem).toContain("1 model can't be used");
    expect(plan.models[2].reason).toContain("don't match any project skeleton");
    expect(plan.runs).toHaveLength(1);
  });

  // An incomplete set for a skeleton is reported per skeleton.
  it("reports a skeleton whose models don't form a pipeline", () => {
    const { labels } = makeTwoSkeletonProject();
    const plan = planMultiSkeletonInference([mouseCi], labels.skeletons);
    expect(plan.problem).toContain("mouse: these models don't form a pipeline");
  });

  // Predicting only one of the skeletons is fine.
  it("allows predicting just one skeleton", () => {
    const { labels } = makeTwoSkeletonProject();
    const plan = planMultiSkeletonInference([pelletCentroid], labels.skeletons);
    expect(plan.problem).toBeNull();
    expect(plan.runs).toHaveLength(1);
  });

  // The per-run config uses that skeleton's models and drops per-skeleton node indices.
  it("builds each run's config from its models", () => {
    const base = { modelPaths: [], pipeline: "bottom-up", kfNodeIndices: [2] } as unknown as InferenceConfig;
    const cfg = configForSkeletonRun(base, {
      skeletonName: "pellet",
      skeletonIndex: 1,
      modelPaths: ["/m/pellet_centroid"],
      pipeline: "centroid-only",
    });
    expect(cfg.modelPaths).toEqual(["/m/pellet_centroid"]);
    expect(cfg.pipeline).toBe("top-down");
    expect(cfg.kfNodeIndices).toEqual([]);
  });
});

describe("auto-picking trained models per skeleton", () => {
  // The Inference panel pre-fills the newest complete model set for each skeleton.
  it("picks the newest complete set for each skeleton", () => {
    const { labels } = makeTwoSkeletonProject();
    const older = model("/m/old_centroid", "centroid", MOUSE);
    const picked = pickModelsForSkeletons(
      [pelletCentroid, mouseCi, mouseCentroid, older, model("/m/fly", "bottomup", ["x"])],
      labels.skeletons,
    );
    expect(picked).toEqual(["/m/mouse_centroid", "/m/mouse_ci", "/m/pellet_centroid"]);
  });
});

describe("reading a model's training_config.yaml", () => {
  // Node names and head come from the sleap-nn config the model was trained with.
  it("parses head and node names", () => {
    const yaml = [
      "data_config:",
      "  skeletons:",
      "  - name: pellet",
      "    nodes:",
      "    - name: centroid",
      "model_config:",
      "  head_configs:",
      "    centroid:",
      "      confmaps: {anchor_part: centroid}",
      "    centered_instance: null",
    ].join("\n");
    const info = parseModelInfo("/m/p", yaml);
    expect(info.headKey).toBe("centroid");
    expect(info.nodeNames).toEqual(["centroid"]);
  });
});

describe("what sleap-nn gets as input", () => {
  // sleap-nn ≤ 0.3.5 crashes on frames mixing skeletons, and a model knows one
  // skeleton: each run gets a copy with only that skeleton's instances.
  it("keeps only one skeleton's instances, with videos and suggestions intact", () => {
    const { labels, video, pellet } = makeTwoSkeletonProject();
    labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 5 }));
    const neg = new LabeledFrame({ video, frameIdx: 20, isNegative: true });
    labels.labeledFrames.push(neg);
    const only = labelsForSkeleton(labels, pellet);
    expect(only.videos).toEqual(labels.videos);
    expect(only.skeletons).toEqual([pellet]);
    expect(only.suggestions).toHaveLength(1);
    expect(only.labeledFrames.map((lf) => lf.frameIdx)).toEqual([0, 10, 20]);
    for (const lf of only.labeledFrames) for (const inst of lf.instances) expect(inst.skeleton).toBe(pellet);
    expect(only.labeledFrames[0].instances).toHaveLength(1);
    // The project itself is untouched.
    expect(labels.labeledFrames[0].instances).toHaveLength(3);
  });

  // Frames with none of this skeleton's instances aren't "labeled" for its model.
  it("drops frames that only have the other skeleton", () => {
    const { labels, video, mouse, f10 } = makeTwoSkeletonProject();
    f10.instances = f10.instances.filter((i) => i.skeleton === mouse);
    const pelletOnly = labelsForSkeleton(labels, labels.skeletons[1]);
    expect(pelletOnly.labeledFrames.map((lf) => lf.frameIdx)).toEqual([0]);
    expect(video).toBeDefined();
  });
});

describe("Connect targets and refusals", () => {
  // A worker reads its own project copy; these targets crash sleap-nn on mixed frames.
  it("refuses user-labeled, predicted and all-videos targets on a worker", () => {
    expect(remoteMultiSkeletonTargetProblem("user_labeled")).toContain("can't run on a worker");
    expect(remoteMultiSkeletonTargetProblem("predicted")).not.toBeNull();
    expect(remoteMultiSkeletonTargetProblem("all_videos")).not.toBeNull();
    for (const ok of ["suggestions", "video", "frame", "random", "random_video"]) {
      expect(remoteMultiSkeletonTargetProblem(ok)).toBeNull();
    }
    expect(remoteMultiSkeletonTargetProblem({ start: 0, end: 5 } as never)).toBeNull();
  });

  // Track-only and a run without skeleton runs are refused before starting.
  it("refuses track-only and missing runs", () => {
    const base = { trackOnly: false, frameRange: "suggestions", skeletonRuns: [] } as unknown as InferenceConfig;
    expect(multiSkeletonRunProblem({ ...base, trackOnly: true }, false)).toContain("Track only");
    expect(multiSkeletonRunProblem(base, false)).toContain("Add a model");
    const withRun = {
      ...base,
      skeletonRuns: [{ skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/a"], pipeline: "bottom-up" as const }],
    };
    expect(multiSkeletonRunProblem(withRun, false)).toBeNull();
    expect(multiSkeletonRunProblem({ ...withRun, frameRange: "user_labeled" }, true)).not.toBeNull();
  });
});

// ── Merging under one skeleton ──────────────────────────────────────────────

function predicted(skeleton: Skeleton, base: [number, number], score = 0.9): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    score,
    points: skeleton.nodeNames.map((name, i) => ({
      xy: [base[0] + 10 * i, base[1] + 10 * i] as [number, number],
      visible: true,
      complete: true,
      score,
      name,
    })),
  });
}

/** A predictions file as sleap-nn writes it: its own skeleton + video objects. */
function predictionsFile(skeleton: Skeleton, frames: Array<[number, PredictedInstance[]]>): Labels {
  const video = new Video({ filename: "/worker/arena.mp4", backendMetadata: { shape: [100, 480, 640, 3] }, openBackend: false });
  return new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: frames.map(([frameIdx, instances]) => new LabeledFrame({ video, frameIdx, instances })),
  });
}

function preds(lf: LabeledFrame | undefined, skeleton: Skeleton): PredictedInstance[] {
  return (lf?.instances ?? []).filter(
    (i): i is PredictedInstance => i instanceof PredictedInstance && i.skeleton === skeleton,
  );
}

describe("merging one model's predictions under its own skeleton", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function load() {
    const project = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(project.labels);
    return project;
  }

  // Replace mode on a pellet run replaces old pellet predictions only — the
  // mouse predictions and every user instance on the same frame stay.
  it("replace only touches the matching skeleton's predictions", async () => {
    const { labels, mouse, pellet, f0 } = load();
    const oldMousePred = predicted(mouse, [500, 50]);
    const oldPelletPred = predicted(pellet, [600, 60]);
    f0.instances.push(oldMousePred, oldPelletPred);

    const modelSkeleton = new Skeleton({ nodes: ["centroid"], name: "pellet" });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(modelSkeleton, [[0, [predicted(modelSkeleton, [205, 305])]]]),
      mode: "replace",
    });

    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    expect(frame?.instances.filter((i) => !(i instanceof PredictedInstance))).toHaveLength(3);
    expect(preds(frame, mouse)).toEqual([oldMousePred]);
    const newPellet = preds(frame, pellet);
    expect(newPellet).toHaveLength(1);
    expect(newPellet[0]).not.toBe(oldPelletPred);
    expect(newPellet[0].points[0].xy).toEqual([205, 305]);
    // No third skeleton appears: the model's skeleton maps onto the project's.
    expect(labels.skeletons).toHaveLength(2);
  });

  // The mouse run's points are remapped by NAME when the model's node order differs.
  it("remaps points by name and attaches them to the project skeleton", async () => {
    const { labels, mouse } = load();
    const modelSkeleton = new Skeleton({ nodes: ["tail", "head", "body"], name: "mouse" });
    const inst = predicted(modelSkeleton, [10, 20]); // tail=(10,20) head=(20,30) body=(30,40)
    await ctx.execute(MergePredictions, { predictions: predictionsFile(modelSkeleton, [[50, [inst]]]), mode: "replace" });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 50);
    const [p] = preds(frame, mouse);
    expect(p.skeleton).toBe(mouse);
    expect(p.points.map((pt) => pt.xy)).toEqual([[20, 30], [30, 40], [10, 20]]);
  });

  // clear_all clears this skeleton's predictions everywhere, not the other's.
  it("clear_all is scoped to the skeleton too", async () => {
    const { labels, mouse, pellet, f0, f10 } = load();
    f0.instances.push(predicted(mouse, [1, 1]));
    f10.instances.push(predicted(pellet, [2, 2]));
    const modelSkeleton = new Skeleton({ nodes: ["head", "body", "tail"], name: "mouse" });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(modelSkeleton, [[10, [predicted(modelSkeleton, [3, 3])]]]),
      mode: "clear_all",
    });
    expect(preds(labels.labeledFrames.find((lf) => lf.frameIdx === 0), mouse)).toHaveLength(0);
    expect(preds(labels.labeledFrames.find((lf) => lf.frameIdx === 10), pellet)).toHaveLength(1);
    expect(preds(labels.labeledFrames.find((lf) => lf.frameIdx === 10), mouse)).toHaveLength(1);
  });

  // One undo step restores the frame exactly (old pellet prediction back).
  it("undoes in one step", async () => {
    const { labels, pellet, f0 } = load();
    const oldPelletPred = predicted(pellet, [600, 60]);
    f0.instances.push(oldPelletPred);
    const modelSkeleton = new Skeleton({ nodes: ["centroid"], name: "pellet" });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(modelSkeleton, [[0, [predicted(modelSkeleton, [1, 1])]]]),
      mode: "replace",
    });
    await ctx.undo();
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    const restored = preds(frame, labels.skeletons[1]);
    expect(restored).toHaveLength(1);
    expect(restored[0].points[0].xy).toEqual([600, 60]);
  });

  // Merging results without being told the skeleton (Connect's Fetch & Load)
  // still finds it by node names.
  it("finds the skeleton by node names when not given", () => {
    const { labels, pellet } = makeTwoSkeletonProject();
    const sk = new Skeleton({ nodes: ["centroid"] });
    expect(resolvePredictionsSkeleton(labels, predictionsFile(sk, [[0, [predicted(sk, [1, 1])]]]))).toBe(pellet);
  });

  // Single-skeleton projects keep the plain merge (no scoping decision made).
  it("leaves single-skeleton projects on the plain merge", () => {
    const mouse = makeMouseSkeleton();
    const labels = new Labels({ skeletons: [mouse] });
    const sk = makeMouseSkeleton();
    expect(resolvePredictionsSkeleton(labels, predictionsFile(sk, [[0, [predicted(sk, [1, 1])]]]))).toBeNull();
  });

  // Predictions whose skeleton differs from the one requested are refused untouched.
  it("refuses predictions for a different skeleton without changing anything", async () => {
    const { labels, mouse } = load();
    const before = labels.labeledFrames.map((lf) => lf.instances.length);
    const other = new Skeleton({ nodes: ["thorax"] });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(other, [[0, [predicted(other, [1, 1])]]]),
      mode: "replace",
      skeleton: mouse,
    });
    expect(labels.labeledFrames.map((lf) => lf.instances.length)).toEqual(before);
    expect(labels.skeletons).toHaveLength(2);
  });

  // User instances of the same skeleton are never removed, in any mode.
  it("keeps user instances of the predicted skeleton", async () => {
    const { labels, pellet } = load();
    const modelSkeleton = new Skeleton({ nodes: ["centroid"], name: "pellet" });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(modelSkeleton, [[0, [predicted(modelSkeleton, [1, 1])]]]),
      mode: "clear_all",
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    const userPellets = frame!.instances.filter((i) => i instanceof Instance && !(i instanceof PredictedInstance) && i.skeleton === pellet);
    expect(userPellets).toHaveLength(1);
  });
});

// ── Fixes from the review of #531 ───────────────────────────────────────────

/** Mice + an unused pellet skeleton: only mice are labeled/predicted so far. */
function miceWithNewPelletSkeleton() {
  const project = makeTwoSkeletonProject();
  for (const lf of project.labels.labeledFrames) {
    lf.instances = lf.instances.filter((i) => i.skeleton !== project.pellet);
  }
  return project;
}

function withTrack<T extends PredictedInstance>(inst: T, track: Track): T {
  inst.track = track;
  return inst;
}

describe("review fixes: Fetch & Load never falls back to a project-wide merge", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  // Finding 1a: a brand-new pellet skeleton has no instances yet — merging the
  // pellet job's predictions must still be scoped and keep the mouse predictions.
  it("scopes a merge into a new, still-unused skeleton", async () => {
    const { labels, mouse, pellet, f0 } = miceWithNewPelletSkeleton();
    useAppStore.getState().setLabels(labels);
    const mousePred = predicted(mouse, [500, 50]);
    f0.instances.push(mousePred);
    expect(needsSkeletonScopedMerge(labels)).toBe(true);

    const sk = new Skeleton({ nodes: ["centroid"] });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(sk, [[0, [predicted(sk, [205, 305])]]]),
      mode: "replace",
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    expect(preds(frame, mouse)).toEqual([mousePred]);
    expect(preds(frame, pellet)).toHaveLength(1);
  });

  // Finding 1b: an empty result with Clear all must not wipe every skeleton's predictions.
  it("refuses an empty Clear all merge without a skeleton", async () => {
    const { labels, mouse, pellet, f0 } = load2();
    f0.instances.push(predicted(mouse, [500, 50]), predicted(pellet, [600, 60]));
    await ctx.execute(MergePredictions, {
      predictions: new Labels({ skeletons: [new Skeleton({ nodes: ["centroid"] })] }),
      mode: "clear_all",
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    expect(preds(frame, mouse)).toHaveLength(1);
    expect(preds(frame, pellet)).toHaveLength(1);
  });

  // Finding 1b with the skeleton known (Fetch & Load now passes it): Clear all
  // on an empty result clears only that skeleton's predictions.
  it("clears only the given skeleton when the result is empty", async () => {
    const { labels, mouse, pellet, f0 } = load2();
    f0.instances.push(predicted(mouse, [500, 50]), predicted(pellet, [600, 60]));
    await ctx.execute(MergePredictions, {
      predictions: new Labels({ skeletons: [new Skeleton({ nodes: ["centroid"] })] }),
      mode: "clear_all",
      skeleton: pellet,
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 0);
    expect(preds(frame, mouse)).toHaveLength(1);
    expect(preds(frame, pellet)).toHaveLength(0);
  });

  function load2() {
    const project = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(project.labels);
    return project;
  }
});

describe("review fixes: tracks stay per skeleton", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  // Finding 2: sleap-nn names tracks track_0… in every run; a mouse and a
  // pellet must not end up on one track.
  it("renames a new track whose name another skeleton uses", async () => {
    const { labels, mouse, pellet } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    const ctx = new CommandContext();
    const mSk = new Skeleton({ nodes: MOUSE });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(mSk, [[40, [withTrack(predicted(mSk, [1, 1]), new Track("track_0"))]]]),
      mode: "replace",
    });
    const pSk = new Skeleton({ nodes: PELLET });
    await ctx.execute(MergePredictions, {
      predictions: predictionsFile(pSk, [[40, [withTrack(predicted(pSk, [9, 9]), new Track("track_0"))]]]),
      mode: "replace",
    });
    const frame = labels.labeledFrames.find((lf) => lf.frameIdx === 40);
    const mouseTrack = preds(frame, mouse)[0].track!;
    const pelletTrack = preds(frame, pellet)[0].track!;
    expect(mouseTrack.name).toBe("track_0");
    expect(pelletTrack.name).toBe("pellet_track_0");
    expect(mouseTrack).not.toBe(pelletTrack);
  });

  // Re-running one skeleton keeps matching its own tracks by name.
  it("re-uses a skeleton's own track on a re-run", async () => {
    const { labels, mouse } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels);
    const ctx = new CommandContext();
    const run = async () => {
      const sk = new Skeleton({ nodes: MOUSE });
      await ctx.execute(MergePredictions, {
        predictions: predictionsFile(sk, [[40, [withTrack(predicted(sk, [1, 1]), new Track("track_0"))]]]),
        mode: "replace",
      });
      return preds(labels.labeledFrames.find((lf) => lf.frameIdx === 40), mouse)[0].track!;
    };
    const first = await run();
    const second = await run();
    expect(second).toBe(first);
  });
});

describe("review fixes: a leftover unused skeleton doesn't make models ambiguous", () => {
  /** Old file with two identical mouse skeletons; an edge edit leaves one unused and different. */
  function editedDuplicateWithPellet() {
    const { labels, a, b } = makeDuplicateSkeletonProject();
    for (const lf of labels.labeledFrames) for (const inst of lf.instances) inst.skeleton = a;
    a.addEdge(a.nodes[0], a.nodes[2]); // the edit: a and b now differ structurally
    const pellet = new Skeleton({ nodes: ["centroid"], name: "pellet" });
    labels.skeletons.push(pellet);
    return { labels, a, b, pellet };
  }

  // Finding 3: matching prefers the skeleton in use when node names tie.
  it("matches the mouse models to the mouse skeleton in use", () => {
    const { labels, a, pellet } = editedDuplicateWithPellet();
    const inUse = skeletonsInUse(labels, pellet);
    expect(matchModelSkeleton(MOUSE, labels.skeletons, inUse)).toEqual({ ok: true, skeleton: a });
    const plan = planMultiSkeletonInference([mouseCentroid, mouseCi, pelletCentroid], labels.skeletons, inUse);
    expect(plan.problem).toBeNull();
    expect(plan.runs.map((r) => r.skeleton)).toEqual([a, pellet]);
  });

  // Finding 3, merge side: predictions resolve to the skeleton in use too.
  it("resolves predictions to the skeleton in use", () => {
    const { labels, a, pellet } = editedDuplicateWithPellet();
    const sk = new Skeleton({ nodes: MOUSE });
    expect(resolvePredictionsSkeleton(labels, predictionsFile(sk, [[0, [predicted(sk, [1, 1])]]]), pellet)).toBe(a);
  });
});

describe("review fixes: centroid-only is for 1-node skeletons", () => {
  // Finding 7: a centroid model alone on the 3-node mouse would overwrite full
  // poses with anchor-only ones, so the plan refuses it with the reason.
  it("refuses a centroid model alone for a multi-node skeleton", () => {
    const { labels } = makeTwoSkeletonProject();
    const plan = planMultiSkeletonInference([mouseCentroid, pelletCentroid], labels.skeletons);
    expect(plan.problem).toContain("Centered Instance");
    expect(plan.runs.find((r) => r.skeletonName === "pellet")?.problem).toBeNull();
  });

  // Finding 7, auto-pick: never pre-fills a lone centroid model for the mice.
  it("doesn't auto-pick a lone centroid model for the mice", () => {
    const { labels } = makeTwoSkeletonProject();
    expect(pickModelsForSkeletons([mouseCentroid, pelletCentroid], labels.skeletons)).toEqual(["/m/pellet_centroid"]);
  });
});

describe("review fixes: per-skeleton copy only when needed", () => {
  const cfg = (frameRange: InferenceConfig["frameRange"], videoIndex: number | "all" = 0) => ({ frameRange, videoIndex });

  // Finding 4: the copy re-serializes the project (all embedded images of a
  // .pkg.slp), so it's only made when sleap-nn would read mixed frames.
  it("copies only for label-scoped targets or mixed frames", () => {
    const { labels } = makeTwoSkeletonProject(); // frames 0 and 10 mix mouse + pellet
    expect(runNeedsSkeletonCopy(labels, cfg("suggestions", "all"), 0)).toBe(false);
    expect(runNeedsSkeletonCopy(labels, cfg("frame"), 5)).toBe(false);
    expect(runNeedsSkeletonCopy(labels, cfg({ start: 20, end: 30 }), 0)).toBe(false);
    expect(runNeedsSkeletonCopy(labels, cfg("frame"), 0)).toBe(true);
    expect(runNeedsSkeletonCopy(labels, cfg({ start: 5, end: 12 }), 0)).toBe(true);
    expect(runNeedsSkeletonCopy(labels, cfg("video"), 0)).toBe(true);
    expect(runNeedsSkeletonCopy(labels, cfg("user_labeled", "all"), 0)).toBe(true);
  });

  // The same frames decide whether a worker job is refused (it reads its own copy).
  it("refuses worker jobs that would read mixed frames", () => {
    const { labels } = makeTwoSkeletonProject();
    expect(remoteMixedFramesProblem(labels, remoteSpecScope({ frame_filter: "suggested" }))).toBeNull();
    expect(remoteMixedFramesProblem(labels, remoteSpecScope({ video_index: 0, frames: "20-30" }))).toBeNull();
    expect(remoteMixedFramesProblem(labels, remoteSpecScope({ video_index: 0, frames: "3,10" }))).toContain("several skeletons");
    expect(remoteMixedFramesProblem(labels, remoteSpecScope({ video_index: 0 }))).toContain("several skeletons");
  });
});

describe("review fixes: failed model reads are retried", () => {
  const ok = model("/w/ok", "centroid", PELLET);
  const failed = model("/w/bad", null, null);

  // Finding 6: an unreadable config (worker briefly offline) mustn't stick forever.
  it("forgets a failed read once the model is removed, or on Retry", () => {
    const cache = { [ok.path]: ok, [failed.path]: failed };
    expect(forgetFailedModelReads(cache, [ok.path, failed.path])).toBe(cache);
    expect(Object.keys(forgetFailedModelReads(cache, [ok.path]))).toEqual([ok.path]);
    expect(Object.keys(forgetFailedModelReads(cache, [ok.path, failed.path], [failed.path]))).toEqual([ok.path]);
    expect(Object.keys(forgetFailedModelReads(cache, [], [ok.path]))).toEqual([ok.path]); // good reads stay
  });
});

describe("per-skeleton settings (one tab per skeleton)", () => {
  // The headline case: mice 2 instances + tracking, pellets 10 instances, no tracking.
  it("gives each skeleton's run its own Max instances, peak threshold and tracking", () => {
    const { labels } = makeTwoSkeletonProject();
    const plan = planMultiSkeletonInference([mouseCentroid, mouseCi, pelletCentroid], labels.skeletons);
    const mice = { ...DEFAULT_SKELETON_INFERENCE_SETTINGS, noMaxInstances: false, maxInstances: 2, tracking: true, noMaxTracks: false, maxTracks: 2 };
    const pellets = { ...DEFAULT_SKELETON_INFERENCE_SETTINGS, noMaxInstances: false, maxInstances: 10, peakThreshold: 0.5 };
    const specs = runSpecsFromPlan(plan, (r) => skeletonRunSettings(r.skeletonName === "mouse" ? mice : pellets));
    const base = { ...DEFAULT_SKELETON_RUN_SETTINGS, modelPaths: [], pipeline: "top-down", kfNodeIndices: [], batchSize: 8 } as unknown as InferenceConfig;
    const [mouseCfg, pelletCfg] = specs.map((s) => configForSkeletonRun(base, s));
    expect([mouseCfg.maxInstances, mouseCfg.tracking, mouseCfg.maxTracks, mouseCfg.peakThreshold]).toEqual([2, true, 2, 0.2]);
    expect([pelletCfg.maxInstances, pelletCfg.tracking, pelletCfg.maxTracks, pelletCfg.peakThreshold]).toEqual([10, false, null, 0.5]);
    // Shared settings still come from the panel's config.
    expect([mouseCfg.batchSize, pelletCfg.batchSize]).toEqual([8, 8]);
  });

  // Each run's settings reach the sleap-nn command line (local) and the Connect job spec.
  it("maps each run's settings to its sleap-nn args and worker job", () => {
    const base = {
      ...DEFAULT_SKELETON_RUN_SETTINGS, pipeline: "top-down", trackOnly: false, modelPaths: [], videoIndex: 0,
      frameRange: "video", sampleCount: 20, excludeUserLabeled: false, existingPredictions: "replace", batchSize: 4,
      device: "auto", runtime: "auto", kfNodeIndices: [], ensureChannels: "auto", filterOverlapping: false,
    } as unknown as InferenceConfig;
    const mouse = configForSkeletonRun(base, {
      skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/c", "/m/ci"], pipeline: "top-down",
      settings: { ...DEFAULT_SKELETON_RUN_SETTINGS, maxInstances: 2, tracking: true, maxTracks: 2 },
    });
    const pellet = configForSkeletonRun(base, {
      skeletonName: "pellet", skeletonIndex: 1, modelPaths: ["/m/p"], pipeline: "centroid-only",
      settings: { ...DEFAULT_SKELETON_RUN_SETTINGS, maxInstances: 10, peakThreshold: 0.5 },
    });
    const mouseArgs = buildInferenceArgs(mouse, { dataPath: "/p.slp", outputPath: "/out.slp" }).join(" ");
    const pelletArgs = buildInferenceArgs(pellet, { dataPath: "/p.slp", outputPath: "/out.slp" }).join(" ");
    expect(mouseArgs).toContain("--max_instances 2");
    expect(mouseArgs).toContain("--tracking");
    expect(mouseArgs).toContain("--max_tracks 2");
    expect(pelletArgs).toContain("--max_instances 10");
    expect(pelletArgs).toContain("--peak_threshold 0.5");
    expect(pelletArgs).not.toContain("--tracking");

    const ctx = { dataPath: "/w/p.slp", pathMappings: {}, videoFrameCounts: [100], currentFrameIdx: 0, activeVideoFrameCount: 100 };
    const [mouseJob] = buildRemoteTrackSpecs(mouse, ctx);
    const [pelletJob] = buildRemoteTrackSpecs(pellet, ctx);
    expect([mouseJob.tracker, mouseJob.max_tracks]).toEqual(["simple", 2]);
    expect([pelletJob.tracker, pelletJob.peak_threshold]).toEqual([undefined, 0.5]);
  });

  // "No limit" ticked sends no limit, but keeps the number typed under it.
  it("sends null for a ticked No limit box", () => {
    const s = { ...DEFAULT_SKELETON_INFERENCE_SETTINGS, maxInstances: 4, noMaxInstances: true, maxTracks: 3, noMaxTracks: true };
    const run = skeletonRunSettings(s);
    expect([run.maxInstances, run.maxTracks]).toEqual([null, null]);
    expect(Object.keys(run).sort()).toEqual([...SKELETON_RUN_SETTING_KEYS].sort());
  });

  // A box detector alone can't be tracked, whatever its tab says.
  it("never tracks a box-detector run", () => {
    const cfg = configForSkeletonRun({ kfNodeIndices: [] } as unknown as InferenceConfig, {
      skeletonName: "mouse", skeletonIndex: 0, modelPaths: ["/m/bbox"], pipeline: "bbox",
      settings: { ...DEFAULT_SKELETON_RUN_SETTINGS, tracking: true },
    });
    expect(cfg.tracking).toBe(false);
  });

  // Saved under name + node set: a renamed or re-noded skeleton starts fresh.
  it("keys saved settings by skeleton name and node set", () => {
    const a = skeletonSettingsKey({ name: "mouse", nodeNames: ["tail", "head"] });
    expect(a).toBe(skeletonSettingsKey({ name: "mouse", nodeNames: ["head", "tail"] }));
    expect(a).not.toBe(skeletonSettingsKey({ name: "mice", nodeNames: ["head", "tail"] }));
    expect(a).not.toBe(skeletonSettingsKey({ name: "mouse", nodeNames: ["head", "tail", "nose"] }));
  });

  // Corrupt or older saved settings fall back to defaults field by field.
  it("fills saved settings out with defaults", () => {
    const s = resolveSkeletonInferenceSettings({ maxInstances: 3, tracking: "yes", maxTracks: null, robust: Number.NaN, extra: 1 });
    expect(s.maxInstances).toBe(3);
    expect(s.tracking).toBe(false);
    expect(s.maxTracks).toBeNull();
    expect(s.robust).toBe(DEFAULT_SKELETON_RUN_SETTINGS.robust);
    expect("extra" in s).toBe(false);
    expect(resolveSkeletonInferenceSettings("garbage")).toEqual(DEFAULT_SKELETON_INFERENCE_SETTINGS);
  });
});
