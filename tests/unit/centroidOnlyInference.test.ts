/**
 * Centroid Only inference: the pipeline's models and checks, the sleap-nn
 * flags, merging its output (no foreign "centroid" skeleton), and predicted
 * centroids on the canvas, in delete/accept commands and in the autosave
 * journal.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  Labels,
  LabeledFrame,
  PredictedCentroid,
  PredictedInstance,
  Skeleton,
  Track,
  UserCentroid,
  Video,
} from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { DeleteAllPredictions, DeleteFramePredictions, MergePredictions, dropUnusedSkeletons } from "@/commands/editCommands";
import { AcceptAllCentroids, DeletePredictedCentroids } from "@/commands/centroidCommands";
import { centroidOnlyProblem } from "@/lib/centroidOnly";
import { centroidOutputFor, type InferenceConfig } from "@/stores/inferenceStore";
import { INFERENCE_DEFAULTS } from "@/lib/inferenceDefaults";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { pickModelsForPipeline, pipelineModelsProblem } from "@/lib/modelDiscovery";
import { applyDeltas, buildBaseIndex, encodeFrameDelta } from "@/lib/autosaveJournal";
import { buildRenderedCentroids, centroidCaption } from "@/canvas/CentroidRenderer";
import { useAppStore } from "@/stores/appStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const video = () => new Video({ filename: "/v/mice.mp4", backendMetadata: { shape: [100, 64, 64, 1] }, openBackend: false });
const mouse = () => new Skeleton({ nodes: ["head", "torso", "tail"], name: "mouse" });

function config(over: Partial<InferenceConfig> = {}): InferenceConfig {
  return { ...INFERENCE_DEFAULTS, modelPaths: ["/m/centroid"], videoIndex: "all", frameRange: "video", ...over };
}

describe("Centroid Only: models, checks and flags", () => {
  it("needs exactly one centroid model; auto-detect picks the newest", () => {
    expect(pipelineModelsProblem("centroid", [{ headKey: "centroid" }])).toBeNull();
    expect(pipelineModelsProblem("centroid", [{ headKey: "centered_instance" }])).toMatch(/Centroid Only needs a model: Centroid/);
    const models = [
      { path: "/m/new", headKey: "centroid", runName: "", mtimeMs: 2, checkpointFile: "best.ckpt" },
      { path: "/m/old", headKey: "centroid", runName: "", mtimeMs: 1, checkpointFile: "best.ckpt" },
    ];
    expect(pickModelsForPipeline(models, "centroid")).toEqual(["/m/new"]);
  });

  it("is refused on a worker and on sleap-nn older than 0.3.5", () => {
    expect(centroidOnlyProblem({ remote: true, sleapNnVersion: "0.3.5" })).toMatch(/worker/);
    expect(centroidOnlyProblem({ remote: false, sleapNnVersion: "0.3.4" })).toMatch(/0\.3\.5 or newer \(installed: 0\.3\.4\)/);
    expect(centroidOnlyProblem({ remote: false, sleapNnVersion: "0.3.5" })).toBeNull();
    expect(centroidOnlyProblem({ remote: false, sleapNnVersion: "0.3.6.dev1+g123" })).toBeNull();
    // Unknown version: let it run (sleap-nn reports its own error).
    expect(centroidOnlyProblem({ remote: false, sleapNnVersion: null })).toBeNull();
  });

  it("1-node skeletons get instances, larger ones centroids", () => {
    expect(centroidOutputFor(1)).toBe("instance");
    expect(centroidOutputFor(3)).toBe("centroid");
  });

  it("sends --centroid_only, and --centroid-output centroid for a multi-node skeleton (which can't be tracked)", () => {
    const io = { dataPath: "in.slp", outputPath: "out.slp" };
    const multi = buildInferenceArgs(config({ pipeline: "centroid", centroidOutput: "centroid", tracking: true }), io);
    expect(multi).toContain("--centroid_only");
    expect(multi[multi.indexOf("--centroid-output") + 1]).toBe("centroid");
    expect(multi).not.toContain("--tracking");
    const single = buildInferenceArgs(config({ pipeline: "centroid", centroidOutput: "instance", tracking: true }), io);
    expect(single).toContain("--centroid_only");
    expect(single).not.toContain("--centroid-output");
    expect(single).toContain("--tracking");
    expect(buildInferenceArgs(config({ pipeline: "top-down" }), io)).not.toContain("--centroid_only");
  });
});

describe("merging a Centroid Only run's output", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  function setup() {
    const sk = mouse();
    const v = video();
    const lf = new LabeledFrame({ video: v, frameIdx: 0, instances: [Instance.fromArray([[1, 1], [2, 2], [3, 3]], sk)] });
    const labels = new Labels({ labeledFrames: [lf], skeletons: [sk], videos: [v] });
    const s = useAppStore.getState();
    s.setLabels(labels, "t.slp");
    s.setVideo(v);
    s.setFrameIdx(0);
    s.setLabeledFrame(lf);
    return { labels, v };
  }

  /** What sleap-nn 0.3.5 writes: centroids, plus an unused 1-node "centroid" skeleton. */
  function output(score: number) {
    const v = video();
    return new Labels({
      labeledFrames: [0, 1].map((f) => new LabeledFrame({ video: v, frameIdx: f, centroids: [new PredictedCentroid({ x: 10 + f, y: 20, score })] })),
      skeletons: [new Skeleton({ nodes: ["centroid"], name: "centroid" })],
      videos: [v],
    });
  }

  it("dropUnusedSkeletons keeps only skeletons instances use", () => {
    const out = output(0.5);
    dropUnusedSkeletons(out);
    expect(out.skeletons).toHaveLength(0);
    const sk = mouse();
    const v = video();
    const used = new Labels({ labeledFrames: [new LabeledFrame({ video: v, frameIdx: 0, instances: [Instance.fromArray([[1, 1], [2, 2], [3, 3]], sk)] })], skeletons: [sk, mouse()], videos: [v] });
    dropUnusedSkeletons(used);
    expect(used.skeletons).toEqual([sk]);
  });

  it("adds no 'centroid' skeleton to the project; Replace replaces the centroids", async () => {
    const { labels, v } = setup();
    await ctx.execute(MergePredictions, { predictions: output(0.5) });
    expect(labels.skeletons.map((s) => s.name)).toEqual(["mouse"]);
    expect(labels.find({ video: v, frameIdx: 1 })[0].centroids).toHaveLength(1);
    await ctx.execute(MergePredictions, { predictions: output(0.9), mode: "replace" });
    const c = labels.find({ video: v, frameIdx: 1 })[0].centroids;
    expect(c.map((x) => (x as PredictedCentroid).score)).toEqual([0.9]);
  });

  it("Clear all and Delete All Predictions remove predicted centroids, keep user ones", async () => {
    const { labels, v } = setup();
    labels.find({ video: v, frameIdx: 0 })[0].centroids.push(new UserCentroid({ x: 5, y: 5 }));
    await ctx.execute(MergePredictions, { predictions: output(0.5) });
    await ctx.execute(MergePredictions, { predictions: new Labels({ videos: [video()] }), mode: "clear_all" });
    expect(labels.find({ video: v, frameIdx: 1 })).toHaveLength(0);
    expect(labels.find({ video: v, frameIdx: 0 })[0].centroids.map((c) => c.isPredicted)).toEqual([false]);
    await ctx.execute(MergePredictions, { predictions: output(0.5) });
    await ctx.execute(DeleteAllPredictions);
    expect(labels.find({ video: v, frameIdx: 1 })).toHaveLength(0);
    expect(labels.find({ video: v, frameIdx: 0 })[0].centroids).toHaveLength(1);
  });

  it("Delete Frame Predictions removes the frame's predicted centroids", async () => {
    const { labels, v } = setup();
    const lf = labels.find({ video: v, frameIdx: 0 })[0];
    lf.centroids.push(new PredictedCentroid({ x: 1, y: 1, score: 0.4 }));
    lf.instances.push(new PredictedInstance({ points: { head: [1, 1], torso: [2, 2], tail: [3, 3] }, skeleton: labels.skeletons[0], score: 0.5 }));
    await ctx.execute(DeleteFramePredictions);
    expect(lf.centroids).toHaveLength(0);
    expect(lf.instances).toHaveLength(1);
  });

  it("accept turns predicted centroids at or above a score into user centroids; delete below a score; one undo step each", async () => {
    const { labels, v } = setup();
    labels.find({ video: v, frameIdx: 0 })[0].centroids.push(new PredictedCentroid({ x: 1, y: 1, score: 0.9 }), new PredictedCentroid({ x: 2, y: 2, score: 0.2 }));
    await ctx.execute(AcceptAllCentroids, { minScore: 0.5 });
    const lf = () => labels.find({ video: v, frameIdx: 0 })[0];
    expect(lf().centroids.map((c) => c.isPredicted)).toEqual([false, true]);
    expect(ctx.undo()).toBe(true);
    expect(lf().centroids.map((c) => c.isPredicted)).toEqual([true, true]);
    await ctx.execute(DeletePredictedCentroids, { maxScore: 0.5 });
    expect(lf().centroids.map((c) => (c as PredictedCentroid).score)).toEqual([0.9]);
    await ctx.execute(DeletePredictedCentroids, {});
    expect(lf().centroids).toHaveLength(0);
  });
});

describe("centroids in the autosave journal and on the canvas", () => {
  it("a frame's centroids survive journal encode → replay (score, track, NaN score)", () => {
    const v = video();
    const t = new Track("A");
    const lf = new LabeledFrame({
      video: v,
      frameIdx: 3,
      centroids: [new PredictedCentroid({ x: 4, y: 5, score: 0.7, track: t }), new PredictedCentroid({ x: 1, y: 1, score: Number.NaN }), new UserCentroid({ x: 9, y: 9 })],
    });
    const live = new Labels({ labeledFrames: [lf], videos: [v], tracks: [t] });
    const base = new Labels({ labeledFrames: [new LabeledFrame({ video: v, frameIdx: 3 })], videos: [v], tracks: [t] });
    const delta = JSON.parse(JSON.stringify(encodeFrameDelta(lf, buildBaseIndex(live))));
    applyDeltas(base, [delta]);
    const got = base.find({ video: v, frameIdx: 3 })[0].centroids;
    expect(got.map((c) => [c.x, c.y, c.isPredicted])).toEqual([[4, 5, true], [1, 1, true], [9, 9, false]]);
    expect((got[0] as PredictedCentroid).score).toBe(0.7);
    expect(got[0].track).toBe(t);
    expect(Number.isNaN((got[1] as PredictedCentroid).score)).toBe(true);
  });

  it("renders positions, scores and labels; skips centroids without a position", () => {
    const out = buildRenderedCentroids(
      [new PredictedCentroid({ x: 4, y: 5, score: 0.734 }), new UserCentroid({ x: Number.NaN, y: 1 }), new UserCentroid({ x: 1, y: 2, category: "pellet" })],
      { toImage: (x, y) => [x * 2, y * 2], colorFor: () => [1, 2, 3] },
    );
    expect(out.map((c) => [c.index, c.x, c.y, c.isPredicted])).toEqual([[0, 8, 10, true], [2, 2, 4, false]]);
    expect(centroidCaption(out[0])).toBe("0.73");
    expect(centroidCaption(out[1])).toBe("pellet");
  });
});
