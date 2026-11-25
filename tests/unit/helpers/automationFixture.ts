/**
 * A small in-memory project for the Claude-connector (automation) tests: one
 * video, a 3-node skeleton (nose → head → tail), user instances on frames 10
 * and 20 (two on frame 20). Loads it into the app store, selects frame 10's
 * instance, and returns a fresh CommandContext.
 */
import { Instance, LabeledFrame, Labels, PredictedInstance, Skeleton, Video } from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";

export const NODE_NAMES = ["nose", "head", "tail"];

export function makeAutomationProject() {
  const skeleton = new Skeleton({ nodes: NODE_NAMES, edges: [["nose", "head"], ["head", "tail"]] });
  const video = new Video({
    filename: "clip.mp4",
    openBackend: false,
    backendMetadata: { shape: [100, 480, 640, 1] },
  });
  const inst = (dx: number) =>
    Instance.fromNumpy({
      pointsData: [
        [100 + dx, 100],
        [110 + dx, 110],
        [130 + dx, 120],
      ],
      skeleton,
    });
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: 10, instances: [inst(0)] }),
      new LabeledFrame({ video, frameIdx: 20, instances: [inst(0), inst(200)] }),
    ],
  });
  return { labels, skeleton, video };
}

/** Load the project into the store, select frame 10's instance, return a CommandContext. */
export function loadFixtureWithOneInstance() {
  useAppStore.setState(useAppStore.getInitialState());
  const project = makeAutomationProject();
  useAppStore.getState().setLabels(project.labels, "clip.slp");
  const ctx = new CommandContext();
  const app = useAppStore.getState();
  app.setVideo(project.video);
  app.setFrameIdx(10);
  const lf = project.labels.find({ video: project.video, frameIdx: 10 })[0];
  useAppStore.getState().setInstance(lf.instances[0]);
  return { ctx, ...project };
}

/** An anomaly score for one user instance (flagged when score ≥ 0.7). */
export function anomalyAt(frameIdx: number, instIdx: number, score: number, issueNodes: number[] = [0]) {
  return {
    videoIdx: 0,
    frameIdx,
    instIdx,
    score,
    confidence: "high" as const,
    topIssue: "Unusual joint angle",
    issueNodes,
    issueKind: "node" as const,
    issueDir: 0,
    contributions: {},
    gmmScore: null,
    gmmIssue: null,
    gmmNode: null,
  };
}

/** A 3-node prediction offset by `dx`, with per-node scores and an instance score. */
export function predictionAt(
  skeleton: Skeleton,
  dx: number,
  nodeScores: [number, number, number],
  score: number,
  dy = 0,
): PredictedInstance {
  return PredictedInstance.fromNumpy({
    pointsData: [
      [100 + dx, 100 + dy, nodeScores[0]],
      [110 + dx, 110 + dy, nodeScores[1]],
      [130 + dx, 120 + dy, nodeScores[2]],
    ],
    skeleton,
    score,
  });
}

/**
 * The automation project plus predictions (prediction review):
 *  - frame 20: a low-scored prediction on top of user instance 0 (already labeled → not a candidate);
 *  - frame 30: A at dx 0 with a low-scored tail (candidate), B at dx 300, confident (not);
 *  - frame 40: C at dx 100 with a low instance score (candidate);
 *  - frame 50: D, low-scored, that a user instance was made from (fromPredicted → not a candidate).
 * Loaded into the app store on frame 10, like loadFixtureWithOneInstance.
 */
export function loadPredictionFixture() {
  useAppStore.setState(useAppStore.getInitialState());
  const base = makeAutomationProject();
  const { skeleton, video, labels } = base;
  const lf20 = labels.find({ video, frameIdx: 20 })[0];
  lf20.instances.push(predictionAt(skeleton, 2, [0.1, 0.1, 0.1], 0.1));
  const a = predictionAt(skeleton, 0, [0.9, 0.9, 0.2], 0.8);
  const b = predictionAt(skeleton, 300, [0.9, 0.95, 0.9], 0.9);
  const c = predictionAt(skeleton, 100, [0.9, 0.9, 0.9], 0.3);
  const d = predictionAt(skeleton, 50, [0.1, 0.1, 0.1], 0.1);
  const fromD = Instance.fromNumpy({
    pointsData: [
      [150, 100],
      [160, 110],
      [180, 120],
    ],
    skeleton,
  });
  fromD.fromPredicted = d;
  const frames = [
    ...labels.labeledFrames,
    new LabeledFrame({ video, frameIdx: 30, instances: [a, b] }),
    new LabeledFrame({ video, frameIdx: 40, instances: [c] }),
    new LabeledFrame({ video, frameIdx: 50, instances: [fromD, d] }),
  ];
  const withPreds = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: frames });
  useAppStore.getState().setLabels(withPreds, "clip.slp");
  const ctx = new CommandContext();
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(10);
  return { ctx, labels: withPreds, skeleton, video, a, b, c, d };
}
