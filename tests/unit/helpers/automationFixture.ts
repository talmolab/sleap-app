/**
 * A small in-memory project for the Claude-connector (automation) tests: one
 * video, a 3-node skeleton (nose → head → tail), user instances on frames 10
 * and 20 (two on frame 20). Loads it into the app store, selects frame 10's
 * instance, and returns a fresh CommandContext.
 */
import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";

export const NODE_NAMES = ["nose", "head", "tail"];

export function makeAutomationProject(opts: { cropRect?: [number, number, number, number] } = {}) {
  const skeleton = new Skeleton({ nodes: NODE_NAMES, edges: [["nose", "head"], ["head", "tail"]] });
  const video = new Video({
    filename: "clip.mp4",
    openBackend: false,
    backendMetadata: { shape: [100, 480, 640, 1] },
  });
  if (opts.cropRect) (video as unknown as { cropRect: number[] }).cropRect = opts.cropRect;
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
export function loadFixtureWithOneInstance(opts?: Parameters<typeof makeAutomationProject>[0]) {
  useAppStore.setState(useAppStore.getInitialState());
  const project = makeAutomationProject(opts);
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
