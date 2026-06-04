/**
 * Tests for "navigate labeled frames only" mode (issue #137):
 *   - the pure stepping/snapping helpers in src/lib/navigableFrames.ts, and
 *   - the store integration where incrementFrameIdx honors navigateLabeledOnly
 *     (and falls through to dense navigation when there are no labeled frames,
 *     so the user is never trapped).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  labeledFrameIndices,
  stepLabeled,
  nearestFrameInDomain,
} from "@/lib/navigableFrames";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

/** Build a backend-less project with labeled frames at the given indices. */
function makeProject(frameIndices: number[]) {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  // Real (backend-less) Video with an explicit shape so setFrameIdx can clamp.
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  for (const f of frameIndices) {
    const lf = new LabeledFrame({ video, frameIdx: f });
    lf.instances.push(Instance.empty({ skeleton }));
    labels.labeledFrames.push(lf);
  }
  return { labels, video, skeleton };
}

describe("stepLabeled", () => {
  const domain = [10, 20, 30];

  it("steps forward to the next labeled frame", () => {
    expect(stepLabeled(domain, 10, 1)).toBe(20);
  });

  it("steps forward from an unlabeled frame to the first labeled one after it", () => {
    expect(stepLabeled(domain, 15, 1)).toBe(20);
  });

  it("wraps forward past the last labeled frame to the first", () => {
    expect(stepLabeled(domain, 30, 1)).toBe(10);
    expect(stepLabeled(domain, 35, 1)).toBe(10);
  });

  it("advances multiple positions on a larger step", () => {
    expect(stepLabeled(domain, 10, 2)).toBe(30);
    // From 25: +1 -> 30, +2 -> wrap to 10.
    expect(stepLabeled(domain, 25, 2)).toBe(10);
  });

  it("steps backward to the previous labeled frame", () => {
    expect(stepLabeled(domain, 30, -1)).toBe(20);
  });

  it("steps backward from an unlabeled frame to the first labeled one before it", () => {
    expect(stepLabeled(domain, 25, -1)).toBe(20);
  });

  it("wraps backward past the first labeled frame to the last", () => {
    expect(stepLabeled(domain, 10, -1)).toBe(30);
    expect(stepLabeled(domain, 5, -1)).toBe(30);
  });

  it("retreats multiple positions on a larger negative step", () => {
    expect(stepLabeled(domain, 30, -2)).toBe(10);
  });

  it("returns the current frame for a zero step", () => {
    expect(stepLabeled(domain, 20, 0)).toBe(20);
  });

  it("returns null for an empty domain (caller falls back to dense)", () => {
    expect(stepLabeled([], 5, 1)).toBeNull();
    expect(stepLabeled([], 5, -1)).toBeNull();
  });

  it("parks on the sole labeled frame when the domain has one entry", () => {
    expect(stepLabeled([42], 42, 1)).toBe(42);
    expect(stepLabeled([42], 42, -1)).toBe(42);
    expect(stepLabeled([42], 10, 1)).toBe(42);
    expect(stepLabeled([42], 50, 1)).toBe(42);
  });

  it("handles a larger multi-step over a 5-entry domain", () => {
    const d = [0, 5, 10, 15, 20];
    expect(stepLabeled(d, 0, 3)).toBe(15);
    expect(stepLabeled(d, 20, -2)).toBe(10);
  });
});

describe("nearestFrameInDomain", () => {
  const domain = [10, 20, 30];

  it("returns the closest entry by frame distance", () => {
    expect(nearestFrameInDomain(domain, 12)).toBe(10);
    expect(nearestFrameInDomain(domain, 16)).toBe(20);
  });

  it("resolves ties to the lower index", () => {
    expect(nearestFrameInDomain(domain, 15)).toBe(10);
  });

  it("clamps to the ends for out-of-range targets", () => {
    expect(nearestFrameInDomain(domain, 100)).toBe(30);
    expect(nearestFrameInDomain(domain, -5)).toBe(10);
  });

  it("returns null for an empty domain", () => {
    expect(nearestFrameInDomain([], 5)).toBeNull();
  });

  it("returns the sole entry for a single-entry domain", () => {
    expect(nearestFrameInDomain([42], 0)).toBe(42);
    expect(nearestFrameInDomain([42], 999)).toBe(42);
  });
});

describe("labeledFrameIndices", () => {
  it("returns [] when labels or video is null", () => {
    const { video } = makeProject([0, 10]);
    expect(labeledFrameIndices(null, video)).toEqual([]);
    expect(labeledFrameIndices(makeProject([0]).labels, null)).toEqual([]);
  });

  it("returns sorted ascending frame indices regardless of insertion order", () => {
    const { labels, video } = makeProject([20, 0, 10]);
    expect(labeledFrameIndices(labels, video)).toEqual([0, 10, 20]);
  });

  it("returns [] for a video with no labeled frames", () => {
    const { labels, video } = makeProject([]);
    expect(labeledFrameIndices(labels, video)).toEqual([]);
  });

  it("excludes empty LabeledFrames (no instances)", () => {
    // pkg.slp files can carry empty LabeledFrames (e.g. leftovers after
    // removing predictions). They have no image and no annotation, so they
    // must not be navigable — navigating to one shows a frozen image. Only
    // frames with at least one instance count.
    const { labels, video, skeleton } = makeProject([10, 30]);
    const empty = new LabeledFrame({ video, frameIdx: 20 }); // no instances
    labels.labeledFrames.push(empty);
    // sanity: skeleton exists so the populated frames are real instances
    expect(skeleton.nodes.length).toBeGreaterThan(0);

    expect(labeledFrameIndices(labels, video)).toEqual([10, 30]);
  });
});

describe("incrementFrameIdx (labeled-only mode)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  function loadLabeledOnly(frameIndices: number[]) {
    const { labels } = makeProject(frameIndices);
    useAppStore.getState().setLabels(labels, "test.slp"); // auto-selects video
    useAppStore.getState().set("navigateLabeledOnly", true);
  }

  it("steps forward only through labeled frames", () => {
    loadLabeledOnly([0, 10, 20]);
    useAppStore.getState().setFrameIdx(0);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(10);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(20);

    // Wraps to the first labeled frame.
    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(0);
  });

  it("steps backward only through labeled frames", () => {
    loadLabeledOnly([0, 10, 20]);
    useAppStore.getState().setFrameIdx(20);

    useAppStore.getState().incrementFrameIdx(-1);
    expect(useAppStore.getState().frameIdx).toBe(10);
  });

  it("falls through to dense stepping when there are no labeled frames", () => {
    loadLabeledOnly([]); // mode ON but nothing to navigate
    useAppStore.getState().setFrameIdx(5);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(6); // dense ±1, never trapped
  });

  it("uses dense stepping when the mode is off", () => {
    const { labels } = makeProject([0, 10, 20]);
    useAppStore.getState().setLabels(labels, "test.slp");
    // navigateLabeledOnly defaults to false.
    useAppStore.getState().setFrameIdx(0);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(1);
  });
});
