/**
 * StatusBar: the project-wide status counts (computeStatusStats) must be
 * memoized so they recompute only when their inputs change (labels content via
 * editSeq, video, totalFrames) — NOT on every frame step.
 *
 * StatusBar subscribes to `frameIdx` (to render "Frame X / Y") and to `editSeq`,
 * and previously called computeStatusStats directly in the render body, so it
 * re-scanned the whole project on every playback tick / scrub / arrow step even
 * though frame navigation never changes the counts (Cluster C).
 *
 * This test proves the memoization by counting computeStatusStats calls: frame
 * navigation must not add calls; a content edit must add exactly one.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Skeleton,
  Video,
  Instance,
  LabeledFrame,
} from "@talmolab/sleap-io.js";
import * as statusStats from "@/lib/statusStats";

// Wrap computeStatusStats with a call counter that runs the real logic. Captured
// before vi.mock so the wrapper delegates to the genuine implementation. The
// module-under-test (StatusBar) is imported dynamically in each test, after the
// mock is registered, so its named import resolves to this counting wrapper.
let computeCalls = 0;
const realCompute = statusStats.computeStatusStats;
const realInstances = statusStats.instancesToShowCount;
vi.mock("@/lib/statusStats", () => ({
  computeStatusStats: (...args: Parameters<typeof realCompute>) => {
    computeCalls++;
    return realCompute(...args);
  },
  instancesToShowCount: realInstances,
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function loadProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.labeledFrames.push(
    new LabeledFrame({ video, frameIdx: 0, instances: [Instance.empty({ skeleton })] })
  );
  labels.labeledFrames.push(
    new LabeledFrame({ video, frameIdx: 5, instances: [Instance.empty({ skeleton })] })
  );
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
}

describe("StatusBar stats memoization", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
    computeCalls = 0;
  });

  it("does not recompute project stats when only the frame changes; does on an edit", async () => {
    loadProject();
    const { StatusBar } = await import("@/components/layout/StatusBar");
    render(<StatusBar />);
    const baseline = computeCalls;
    expect(baseline).toBeGreaterThan(0);

    // Frame navigation (playback / scrub / arrow) re-renders StatusBar to update
    // the frame readout, but must NOT re-scan the project.
    act(() => {
      useAppStore.getState().setFrameIdx(1);
    });
    act(() => {
      useAppStore.getState().setFrameIdx(2);
    });
    expect(computeCalls).toBe(baseline);

    // A content edit bumps editSeq → the counts must refresh (exactly once).
    act(() => {
      useAppStore.getState().markChanged();
    });
    expect(computeCalls).toBe(baseline + 1);
  });
});
