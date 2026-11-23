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
  Video,
} from "@talmolab/sleap-io.js";
import {
  configForSkeletonRun,
  labelsForSkeleton,
  matchModelSkeleton,
  multiSkeletonRunProblem,
  parseModelInfo,
  pickModelsForSkeletons,
  pipelineForModels,
  planMultiSkeletonInference,
  remoteMultiSkeletonTargetProblem,
  runSpecsFromPlan,
  type ModelInfo,
} from "@/lib/multiSkeletonInference";
import { resolvePredictionsSkeleton } from "@/lib/skeletonScopedMerge";
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
