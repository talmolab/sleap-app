/**
 * Tests for the active-learning Phase-2 → Phase-3 handoff.
 *
 * Three pieces: the `reviewSignal` summary that a finished post-training
 * inference run raises, the `pendingReview` store flag it lands in (and what
 * consumes it), and `setupPoseTraining`, which preps the Training panel without
 * choosing a pipeline.
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
import { reviewSignal } from "@/lib/activeLearning/reviewQueue";
import { setupPoseTraining } from "@/lib/activeLearning/trainPose";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore } from "@/stores/trainingStore";

const NODE_NAMES = ["head", "body", "tail"];

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
}

function stubVideo(name = "v.mp4"): Video {
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

/** A predicted instance whose worst keypoint score is `worst`. */
function makePredicted(skeleton: Skeleton, worst: number): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    points: skeleton.nodes.map((n, i) => ({
      xy: [10, 20] as [number, number],
      visible: true,
      complete: true,
      name: n.name,
      score: i === 0 ? worst : 0.99,
    })),
    score: 0.9,
  });
}

/** A user instance — never scored, never queued. */
function makeUser(skeleton: Skeleton): Instance {
  const inst = Instance.empty({ skeleton });
  for (let i = 0; i < skeleton.nodes.length; i++) {
    inst.points[i].xy = [5, 5];
    inst.points[i].visible = true;
  }
  return inst;
}

function labelsWith(instances: (skeleton: Skeleton) => Instance[]): Labels {
  const skeleton = makeSkeleton();
  const video = stubVideo();
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  for (const inst of instances(skeleton)) lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

describe("reviewSignal", () => {
  it("separates flagged from total so the three outcomes read differently", () => {
    const labels = labelsWith((s) => [
      makePredicted(s, 0.1), // flagged
      makePredicted(s, 0.25), // flagged
      makePredicted(s, 0.8), // confident
    ]);
    expect(reviewSignal(labels, 0.3)).toEqual({ flagged: 2, total: 3 });
  });

  it("reports merged-but-confident as flagged 0, total > 0", () => {
    // The 'good model' case. Must NOT look like 'nothing merged', or the panel
    // would tell the user something went wrong when it went right.
    const labels = labelsWith((s) => [makePredicted(s, 0.9), makePredicted(s, 0.95)]);
    expect(reviewSignal(labels, 0.3)).toEqual({ flagged: 0, total: 2 });
  });

  it("reports nothing-to-rank as total 0 when only user instances exist", () => {
    const labels = labelsWith((s) => [makeUser(s), makeUser(s)]);
    expect(reviewSignal(labels, 0.3)).toEqual({ flagged: 0, total: 0 });
  });

  it("is inclusive at the threshold, matching buildReviewQueue", () => {
    const labels = labelsWith((s) => [makePredicted(s, 0.3)]);
    expect(reviewSignal(labels, 0.3).flagged).toBe(1);
    expect(reviewSignal(labels, 0.29).flagged).toBe(0);
  });

  it("counts user instances out of `total` even alongside predictions", () => {
    const labels = labelsWith((s) => [makeUser(s), makePredicted(s, 0.1), makeUser(s)]);
    expect(reviewSignal(labels, 0.3)).toEqual({ flagged: 1, total: 1 });
  });
});

describe("pendingReview store flag", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("starts null and round-trips through setPendingReview", () => {
    expect(useAppStore.getState().pendingReview).toBeNull();
    useAppStore.getState().setPendingReview({ flagged: 4, total: 9 });
    expect(useAppStore.getState().pendingReview).toEqual({ flagged: 4, total: 9 });
    useAppStore.getState().setPendingReview(null);
    expect(useAppStore.getState().pendingReview).toBeNull();
  });

  it("is consumed by entering correct mode, so the badge can't go stale", () => {
    useAppStore.getState().setPendingReview({ flagged: 4, total: 9 });
    useAppStore.getState().enterCorrectMode({ queue: [] });
    expect(useAppStore.getState().pendingReview).toBeNull();
    expect(useAppStore.getState().labelingMode).toBe("correct");
  });
});

describe("setupPoseTraining", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useTrainingStore.getState().reset();
    useTrainingStore.getState().setPendingHandoff(null);
  });

  it("refuses without a saved project — training reads the .slp from disk", () => {
    useAppStore.setState({ projectPath: null });
    expect(setupPoseTraining()).toBe(false);
    expect(useTrainingStore.getState().pendingHandoff).toBeNull();
  });

  it("points training at the project and presets the AL inference scope", () => {
    useAppStore.setState({ projectPath: "/proj.slp" });
    expect(setupPoseTraining()).toBe(true);

    const t = useTrainingStore.getState();
    expect(t.config.trainingLabelsPath).toBe("/proj.slp");
    // "unlabeled frames of this video" — becomes --exclude_user_labeled.
    expect(t.pendingHandoff?.inferenceTarget).toBe("video");
    expect(t.pendingHandoff?.skipUserLabeled).toBe(true);
    expect(t.pendingHandoff?.requireModelTypeChoice).toBe(true);
  });

  it("does NOT choose a pipeline — top-down vs bottom-up is the user's call", () => {
    useAppStore.setState({ projectPath: "/proj.slp" });
    const before = useTrainingStore.getState().config.modelType;
    setupPoseTraining();
    expect(useTrainingStore.getState().config.modelType).toBe(before);
    expect(useTrainingStore.getState().pendingHandoff?.requireModelTypeChoice).toBe(true);
  });
});
