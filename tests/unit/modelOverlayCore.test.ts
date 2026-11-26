/**
 * Compare Model Predictions: checking a prediction file against the project
 * (video match, skeleton check, model name) and pulling out its poses.
 */
import { describe, it, expect } from "../bun-test";
import { LabeledFrame, Labels, Skeleton } from "@talmolab/sleap-io.js";
import {
  analyzePredictionFile,
  checkSkeleton,
  isTrainingSplitFile,
  extractPoses,
  matchVideo,
  modelNameFromProvenance,
  nextModelColor,
  MODEL_COLORS,
  targetFromVideo,
  uniqueModelName,
} from "@/lib/modelOverlay/core";
import { NODES, makePred, makePredictionLabels, makeVideo, poseAt } from "./modelOverlayTestData";
import { rowNote } from "@/components/dialogs/CompareModelsDialog";

const target = targetFromVideo(makeVideo());

describe("matchVideo", () => {
  // The normal case: the predictions were made on the very same file.
  it("matches the same path, even with Windows separators", () => {
    const v = makeVideo("\\data\\session1\\mouse.mp4");
    const m = matchVideo([makeVideo("/other/a.mp4"), v], target);
    expect(m.ok && m.video === v && m.by === "path").toBe(true);
  });

  // Predictions run on another machine: different folder, same video.
  it("falls back to the file name when frame count and size agree", () => {
    const v = makeVideo("/cluster/run/mouse.mp4");
    const m = matchVideo([v], target);
    expect(m.ok && m.by === "name").toBe(true);
  });

  // Older files don't record the video's size; that alone mustn't block the match,
  // but with nothing to confirm it, it's only "probable" (listed, not ticked).
  it("calls a same-name video with no recorded size a probable match", () => {
    const m = matchVideo([makeVideo("/cluster/mouse.mp4", null)], target);
    expect(m.ok && m.by).toBe("probable");
  });

  // Review: a project video of unknown size used to match any same-named file.
  it("needs a confirming size when the project video's size is unknown", () => {
    const unknown = targetFromVideo(makeVideo("/data/session1/mouse.mp4", null));
    const m = matchVideo([makeVideo("/cluster/mouse.mp4", [50, 10, 10, 1])], unknown);
    expect(m.ok && m.by).toBe("probable");
  });

  // Same name but a different recording (e.g. a re-encode) must not be overlaid.
  it("refuses a same-name video with a different frame count, saying both sizes", () => {
    const m = matchVideo([makeVideo("/cluster/mouse.mp4", [50, 480, 640, 1])], target);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toContain("50 frames");
  });

  // The reason lists what the file does contain, so the user can tell why.
  it("names the file's videos when none match", () => {
    const m = matchVideo([makeVideo("/x/rat.mp4")], target);
    expect(m.ok ? "" : m.reason).toBe("Doesn't contain this video (has rat.mp4)");
  });
});

describe("checkSkeleton", () => {
  // Node order doesn't matter; the map says where each project node lives in the file.
  it("accepts the same names in another order and maps them", () => {
    const sk = new Skeleton({ nodes: ["abdomen", "head", "thorax"] });
    const c = checkSkeleton(NODES, sk);
    expect(c.ok && c.nodeMap).toEqual([1, 2, 0]);
  });

  // The user decided: refuse different skeletons with the reason, e.g. missing nodes.
  it("refuses missing nodes with the reason", () => {
    const c = checkSkeleton(NODES, new Skeleton({ nodes: ["head"] }));
    expect(c.ok ? "" : c.reason).toBe("Skeleton differs: missing nodes thorax, abdomen");
  });

  // Extra nodes are a different skeleton too (would mean comparing different body parts).
  it("refuses extra nodes with the reason", () => {
    const c = checkSkeleton(["head"], new Skeleton({ nodes: ["head", "tail"] }));
    expect(c.ok ? "" : c.reason).toBe("Skeleton differs: extra node tail");
  });
});

describe("modelNameFromProvenance", () => {
  // sleap-nn records model folders; a top-down pipeline has two.
  it("joins the model folder names", () => {
    expect(
      modelNameFromProvenance({ model_paths: ["/m/models/run.centroid", "/m/models/run.centered_instance/best.ckpt"] }, "p.slp")
    ).toBe("run.centroid + run.centered_instance");
  });

  // No provenance (e.g. converted files): the file name is the next best label.
  it("falls back to the file name", () => {
    expect(modelNameFromProvenance({}, "/a/b/labels.predictions.slp")).toBe("labels.predictions");
  });
});

describe("extractPoses / analyzePredictionFile", () => {
  // Poses come out in the project's node order, so node i means the same part for every model.
  it("reorders poses into the project's node order", () => {
    const labels = makePredictionLabels({ nodes: ["abdomen", "head", "thorax"], frames: { 3: [{ xy: poseAt(50, 60) }] } });
    const c = checkSkeleton(NODES, labels.skeletons[0]);
    if (!c.ok) throw new Error("expected ok");
    const poses = extractPoses(labels, labels.videos[0], c.nodeMap);
    expect(Array.from(poses.get(3)![0].xy)).toEqual([50, 50, 50, 60, 50, 70]);
  });

  // A usable file reports its frames and name; the poses are kept for drawing.
  it("returns the poses for a matching file", () => {
    const labels = makePredictionLabels({
      frames: { 0: [{ xy: poseAt(10, 20), track: "a" }], 5: [{ xy: poseAt(1, 2) }] },
      provenance: { model_paths: ["/m/models/single"] },
    });
    const a = analyzePredictionFile(labels, "p.slp", target, NODES);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.name).toBe("single");
      expect(a.frameCount).toBe(2);
      expect(a.frames.get(0)![0].trackName).toBe("a");
    }
  });

  // A label file without predictions on this video isn't a model's output.
  it("refuses a file with no predictions for this video", () => {
    const labels = makePredictionLabels({ frames: {} });
    const a = analyzePredictionFile(labels, "labels.slp", target, NODES);
    expect(a.ok ? "" : a.reason).toBe("No predictions for this video");
  });

  // The skeleton reason reaches the dialog unchanged.
  it("passes the skeleton reason through", () => {
    const labels = makePredictionLabels({ nodes: ["head", "thorax"], frames: { 0: [{ xy: poseAt(1, 1) }] } });
    const a = analyzePredictionFile(labels, "p.slp", target, NODES);
    expect(a.ok ? "" : a.reason).toBe("Skeleton differs: missing node abdomen");
  });
});

describe("isTrainingSplitFile", () => {
  // sleap-nn writes models/<run>/labels_pr.<split>[.<n>].slp; those only cover labeled frames.
  it("recognises a run's split predictions", () => {
    expect(isTrainingSplitFile("/p/models/run/labels_pr.train.slp")).toBe(true);
    expect(isTrainingSplitFile("C:\\p\\models\\run\\labels_pr.val.0.slp")).toBe(true);
    expect(isTrainingSplitFile("/p/labels.v001.predictions.slp")).toBe(false);
  });
});

describe("colours and names", () => {
  // Each new model gets the first colour no loaded model is using.
  it("hands out unused colours first", () => {
    expect(nextModelColor([MODEL_COLORS[0]], 1)).toEqual(MODEL_COLORS[1]);
    expect(nextModelColor([MODEL_COLORS[1]], 1)).toEqual(MODEL_COLORS[0]);
  });

  // Two files with the same provenance (same model, two runs) stay tell-apart-able in the legend.
  it("numbers repeated names", () => {
    expect(uniqueModelName("m", ["m", "m (2)"])).toBe("m (3)");
  });
});

describe("prediction files with several skeletons (#99)", () => {
  /** A mice + pellets output: a 3-node mouse and a 1-node pellet on frame 0. */
  function micePelletFile(): Labels {
    const video = makeVideo();
    const mouse = new Skeleton({ nodes: ["abdomen", "head", "thorax"], name: "mouse" });
    const pellet = new Skeleton({ nodes: ["centroid"], name: "pellet" });
    const lf = new LabeledFrame({
      video,
      frameIdx: 0,
      instances: [makePred(pellet, [[5, 5]]), makePred(mouse, [[1, 30], [1, 10], [1, 20]])],
    });
    return new Labels({ videos: [video], skeletons: [mouse, pellet], labeledFrames: [lf] });
  }

  // Multi-skeleton inference writes mice + pellets in one project: compare the
  // active skeleton's predictions and ignore the other skeleton, with a note.
  it("compares only the predictions with the project's node names", () => {
    const a = analyzePredictionFile(micePelletFile(), "p.slp", target, NODES);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const poses = a.frames.get(0)!;
    expect(poses).toHaveLength(1);
    expect(Array.from(poses[0].xy)).toEqual([1, 10, 1, 20, 1, 30]);
    expect(a.ignoredSkeletons).toBe(1);
    expect(rowNote("/p/p.slp", { ok: true, name: a.name, frameCount: 1, matchedBy: "path", ignoredSkeletons: 1, skeletonName: "mouse" }))
      .toBe("Using mouse predictions only (1 other skeleton ignored)");
  });

  // With the pellet skeleton active, the same file compares its pellets.
  it("compares the other skeleton's part when that one is active", () => {
    const a = analyzePredictionFile(micePelletFile(), "p.slp", target, ["centroid"]);
    expect(a.ok && a.frames.get(0)?.length).toBe(1);
    expect(a.ok && a.skeletonName).toBe("pellet");
  });

  // No skeleton in the file matches: still refused, with a reason.
  it("refuses when none of its skeletons matches", () => {
    const a = analyzePredictionFile(micePelletFile(), "p.slp", target, ["wingL", "wingR"]);
    expect(a.ok ? "" : a.reason).toContain("None of its 2 skeletons");
  });
});
