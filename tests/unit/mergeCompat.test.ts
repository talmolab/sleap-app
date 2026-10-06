/**
 * PR5a.7 — mergeCompat.ts: checkMergeCompat predicts the real
 * MergePredictions merge (editCommands.ts: video "basename", track "name",
 * default/STRUCTURE skeleton) without mutating anything; filterPredictions-
 * ToMatchedVideos trims a predictions Labels down to only the videos the
 * open project has; translatePathToLocal mirrors translatePath in reverse.
 */
import { describe, it, expect } from "../bun-test";
import { Labels, Skeleton, Video, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import type { PathMapping } from "@/lib/pathMappings";
import {
  checkMergeCompat,
  filterPredictionsToMatchedVideos,
  translatePathToLocal,
} from "@/lib/mergeCompat";

function makeVideo(filename: string): Video {
  return new Video({ filename, backendMetadata: { shape: [10, 8, 8, 1] }, openBackend: false });
}

function makeSkeleton(nodes: string[], name = "s"): Skeleton {
  return new Skeleton({ nodes, name });
}

function makeLabels(opts: { videos: Video[]; skeleton: Skeleton }): Labels {
  const frames = opts.videos.map((video) => {
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(Instance.empty({ skeleton: opts.skeleton }));
    return lf;
  });
  return new Labels({ videos: opts.videos, skeletons: [opts.skeleton], labeledFrames: frames });
}

const RULES: PathMapping[] = [{ local: "/Users/me/data", worker: "/mnt/data" }];

describe("checkMergeCompat", () => {
  it("same-file fast path: the project's translated path equals the job's worker labels path", async () => {
    const skeleton = makeSkeleton(["head", "tail"]);
    // Deliberately a DIFFERENT (mismatched) skeleton from the open project's
    // own -- the fast path must short-circuit before ever comparing them.
    const project = makeLabels({ videos: [], skeleton: makeSkeleton(["unrelated"]) });
    const predictions = makeLabels({ videos: [makeVideo("a.mp4"), makeVideo("b.mp4")], skeleton });

    const compat = await checkMergeCompat(project, predictions, {
      projectPath: "/Users/me/data/labels.slp",
      jobLabelsPath: "/mnt/data/labels.slp",
      rules: RULES,
    });

    expect(compat.sameFile).toBe(true);
    expect(compat.skeletonOk).toBe(true);
    expect(compat.matchedCount).toBe(2);
    expect(compat.total).toBe(2);
    expect(compat.videos.every((v) => v.matched)).toBe(true);
  });

  it("no project open: fully incompatible, nothing matched", async () => {
    const skeleton = makeSkeleton(["head", "tail"]);
    const predictions = makeLabels({ videos: [makeVideo("a.mp4")], skeleton });

    const compat = await checkMergeCompat(null, predictions, {
      projectPath: null,
      jobLabelsPath: "/mnt/data/labels.slp",
      rules: RULES,
    });

    expect(compat.sameFile).toBe(false);
    expect(compat.skeletonOk).toBe(false);
    expect(compat.matchedCount).toBe(0);
    expect(compat.total).toBe(1);
    expect(compat.videos).toEqual([{ name: "a.mp4", matched: false }]);
  });

  it("partial video match: 1 of 2 predicted videos exist in the project (by basename), compatible skeleton", async () => {
    const skeleton = makeSkeleton(["head", "tail"]);
    const project = makeLabels({ videos: [makeVideo("/local/path/a.mp4")], skeleton });
    const predictions = makeLabels({
      videos: [makeVideo("/worker/path/a.mp4"), makeVideo("/worker/path/b.mp4")],
      skeleton: makeSkeleton(["head", "tail"]), // same structure, different instance
    });

    const compat = await checkMergeCompat(project, predictions, {
      projectPath: "/Users/me/data/labels.slp",
      jobLabelsPath: "/mnt/data/other_labels.slp", // doesn't match -> not the same-file fast path
      rules: RULES,
    });

    expect(compat.sameFile).toBe(false);
    expect(compat.skeletonOk).toBe(true);
    expect(compat.matchedCount).toBe(1);
    expect(compat.total).toBe(2);
    expect(compat.videos).toEqual([
      { name: "a.mp4", matched: true },
      { name: "b.mp4", matched: false },
    ]);
  });

  it("skeleton mismatch disables compatibility even when every video matches", async () => {
    const project = makeLabels({
      videos: [makeVideo("/local/a.mp4")],
      skeleton: makeSkeleton(["head", "thorax", "abdomen"]),
    });
    const predictions = makeLabels({
      videos: [makeVideo("/worker/a.mp4")],
      skeleton: makeSkeleton(["nose", "tail"]), // different node names entirely
    });

    const compat = await checkMergeCompat(project, predictions, {
      projectPath: "/Users/me/data/labels.slp",
      jobLabelsPath: "/mnt/data/other.slp",
      rules: RULES,
    });

    expect(compat.sameFile).toBe(false);
    expect(compat.skeletonOk).toBe(false);
    expect(compat.skeletonDetail).toContain("Skeleton doesn't match");
    // Videos still matched by basename -- the skeleton is what blocks merging.
    expect(compat.matchedCount).toBe(1);
  });
});

describe("filterPredictionsToMatchedVideos", () => {
  it("keeps only the frames of videos the project also has (by basename)", () => {
    const skeleton = makeSkeleton(["head", "tail"]);
    const project = makeLabels({ videos: [makeVideo("/local/a.mp4")], skeleton });
    const predictions = makeLabels({
      videos: [makeVideo("/worker/a.mp4"), makeVideo("/worker/b.mp4")],
      skeleton,
    });

    const filtered = filterPredictionsToMatchedVideos(predictions, project);

    expect(filtered.videos).toHaveLength(1);
    expect(filtered.videos[0].filename).toBe("/worker/a.mp4");
    expect(filtered.labeledFrames).toHaveLength(1);
    expect(filtered.labeledFrames[0].video.filename).toBe("/worker/a.mp4");
  });

  it("keeps nothing when no video matches", () => {
    const skeleton = makeSkeleton(["head", "tail"]);
    const project = makeLabels({ videos: [makeVideo("/local/unrelated.mp4")], skeleton });
    const predictions = makeLabels({ videos: [makeVideo("/worker/a.mp4")], skeleton });

    const filtered = filterPredictionsToMatchedVideos(predictions, project);

    expect(filtered.videos).toHaveLength(0);
    expect(filtered.labeledFrames).toHaveLength(0);
  });
});

describe("translatePathToLocal", () => {
  it("maps a worker path back to local via the longest-prefix-matching rule", () => {
    const rules: PathMapping[] = [
      { local: "/Users/me/data", worker: "/mnt/data" },
      { local: "/Users/me/data/videos", worker: "/mnt/data/videos" }, // more specific -- longest prefix wins
    ];

    expect(translatePathToLocal("/mnt/data/videos/a.mp4", rules)).toBe(
      "/Users/me/data/videos/a.mp4",
    );
    expect(translatePathToLocal("/mnt/data/labels.slp", rules)).toBe(
      "/Users/me/data/labels.slp",
    );
  });

  it("returns null when no rule's worker prefix matches", () => {
    expect(translatePathToLocal("/other/path/a.mp4", RULES)).toBeNull();
  });

  it("is the reverse of translatePath for the same rule set", async () => {
    const { translatePath } = await import("@/lib/pathMappings");
    const localPath = "/Users/me/data/sub/labels.slp";
    const workerPath = translatePath(localPath, RULES);

    expect(workerPath).toBe("/mnt/data/sub/labels.slp");
    expect(translatePathToLocal(workerPath!, RULES)).toBe(localPath);
  });
});
