/**
 * Tests for the Phase-3 correction mode in the app store: entering with a
 * review queue, cursor advance/back, selection sync, the completed state, and
 * teardown on exit / new project.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { buildReviewQueue } from "@/lib/activeLearning/reviewQueue";

const NODE_NAMES = ["head", "body", "tail"];

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
}

function stubVideo(name: string): Video {
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

function makePredicted(skeleton: Skeleton, scores: Record<string, number>): PredictedInstance {
  return new PredictedInstance({
    skeleton,
    points: skeleton.nodes.map((n) => ({
      xy: [10, 20] as [number, number],
      visible: true,
      complete: true,
      name: n.name,
      score: n.name in scores ? scores[n.name] : 0.99,
    })),
    score: 0.9,
  });
}

/** A project with three predicted instances of increasing worst-keypoint score. */
function setupProject() {
  const sk = makeSkeleton();
  const v = stubVideo("a.mp4");
  const f0 = makePredicted(sk, { body: 0.5 }); // worst 0.5
  const f1 = makePredicted(sk, { tail: 0.1 }); // worst 0.1 (queued first)
  const f2 = makePredicted(sk, { head: 0.3 }); // worst 0.3
  const labels = new Labels({
    videos: [v],
    skeletons: [sk],
    labeledFrames: [
      new LabeledFrame({ video: v, frameIdx: 0, instances: [f0] }),
      new LabeledFrame({ video: v, frameIdx: 1, instances: [f1] }),
      new LabeledFrame({ video: v, frameIdx: 2, instances: [f2] }),
    ],
  });
  return { labels, sk, v, f0, f1, f2 };
}

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("appStore correction mode", () => {
  beforeEach(() => {
    resetStore();
  });

  it("enters correct mode and frames the worst item first", () => {
    const { labels, f1 } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    const queue = buildReviewQueue(labels);
    store.enterCorrectMode({ queue });

    const s = useAppStore.getState();
    expect(s.labelingMode).toBe("correct");
    expect(s.correctQueue.length).toBe(3);
    expect(s.correctCursor).toBe(0);
    // Worst keypoint (0.1) is frame 1 — selection is synced to it.
    expect(s.frameIdx).toBe(1);
    expect(s.instance).toBe(f1);
  });

  it("advances and steps back through the queue, syncing selection", () => {
    const { labels, f1, f2, f0 } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels) });

    // Order by worst score: f1 (0.1) → f2 (0.3) → f0 (0.5)
    expect(useAppStore.getState().instance).toBe(f1);
    store.correctAdvance();
    expect(useAppStore.getState().correctCursor).toBe(1);
    expect(useAppStore.getState().instance).toBe(f2);
    store.correctAdvance();
    expect(useAppStore.getState().instance).toBe(f0);

    store.correctBack();
    expect(useAppStore.getState().correctCursor).toBe(1);
    expect(useAppStore.getState().instance).toBe(f2);
  });

  it("clamps at the end into a completed state that keeps the mode active", () => {
    const { labels } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels) });

    store.correctAdvance();
    store.correctAdvance();
    store.correctAdvance(); // past the last item
    const s = useAppStore.getState();
    expect(s.correctCursor).toBe(3); // === queue length
    expect(s.labelingMode).toBe("correct"); // mode stays for the "done" HUD

    // Extra advances never run off the end.
    store.correctAdvance();
    expect(useAppStore.getState().correctCursor).toBe(3);
  });

  it("exits correct mode and clears the queue", () => {
    const { labels } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels) });
    store.exitCorrectMode();

    const s = useAppStore.getState();
    expect(s.labelingMode).toBe("select");
    expect(s.correctQueue.length).toBe(0);
    expect(s.correctCursor).toBe(0);
  });

  it("loading a new project tears down an active correction sweep", () => {
    const { labels } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels) });
    expect(useAppStore.getState().labelingMode).toBe("correct");

    const { labels: labels2 } = setupProject();
    store.setLabels(labels2);
    const s = useAppStore.getState();
    expect(s.labelingMode).toBe("select");
    expect(s.correctQueue.length).toBe(0);
    expect(s.correctCursor).toBe(0);
  });

  it("respects a custom zoom window", () => {
    const { labels } = setupProject();
    const store = useAppStore.getState();
    store.setLabels(labels);
    store.enterCorrectMode({ queue: buildReviewQueue(labels), zoomWindow: 128 });
    expect(useAppStore.getState().correctZoomWindow).toBe(128);
    store.setCorrectZoomWindow(8); // floored to 16
    expect(useAppStore.getState().correctZoomWindow).toBe(16);
  });
});
