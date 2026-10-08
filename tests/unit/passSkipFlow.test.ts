/**
 * Tests for "skip this whole instance" in the Phase-2 sweep
 * (`skipCurrentPassItem`), at the store + command level a real GUI drives.
 *
 * The point of the feature: `s` skips one NODE and leaves it undecided, so a bad
 * animal comes back node by node on every pass and on every resume. Skipping the
 * INSTANCE decides all of its nodes at once — while keeping the centroid, which
 * is what separates it from rejecting a false-positive detection.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  Skeleton,
  Video,
  UserCentroid,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { normalizeActiveLearningConfig } from "@/lib/activeLearning/config";
import {
  buildWorkList,
  passDims,
  nodeIndicesForPass,
  markInstanceDecided,
} from "@/lib/activeLearning/passEngine";
import { skipCurrentPassItem } from "@/lib/activeLearning/passActions";

const NODE_NAMES = ["head", "nose", "tail"];

function stubVideo(name: string): Video {
  const shape: [number, number, number, number] = [10, 480, 640, 1];
  const backend = { shape, getFrame: async () => null } as unknown as NonNullable<Video["backend"]>;
  return new Video({ filename: name, backend });
}

/** Default (separate-centroid) workflow with one pass over head → nose. */
function makeConfig() {
  return normalizeActiveLearningConfig({
    labelKeypoints: { passes: [{ name: "p1", nodes: ["head", "nose"], axis: false }] },
  });
}

/**
 * A project in the shape Phase-2 actually sweeps: one seeded `UserCentroid` per
 * animal, each paired with an empty pose instance (what `PairPoseInstances`
 * creates). `frames` gives the frame indices, one animal each.
 */
function setupProject(frames: number[]) {
  const skeleton = new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
  const video = stubVideo("a.mp4");
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  for (const frameIdx of frames) {
    const lf = new LabeledFrame({ video, frameIdx });
    lf.centroids.push(new UserCentroid({ x: 100 + frameIdx, y: 200 }));
    lf.instances.push(Instance.empty({ skeleton }));
    labels.labeledFrames.push(lf);
  }
  return { labels, skeleton, video };
}

/** Enter the sweep the way ActiveLearningPanel.startKeypointPasses does. */
function enterSweep(labels: Labels, skeleton: Skeleton) {
  const config = makeConfig();
  const names = skeleton.nodes.map((n) => n.name);
  useAppStore.getState().setLabels(labels); // also adopts video[0] + skeleton[0]
  const workList = buildWorkList(labels, config);
  const dims = passDims(config, workList, names);
  const nodeIndices = config.labelKeypoints.passes.map((p) => nodeIndicesForPass(p, names));
  useAppStore.getState().enterKeypointPassMode({ workList, dims, nodeIndices });
  return { config, workList, dims };
}

/** Are all of this instance's points marked decided? */
function fullyDecided(inst: Instance): boolean {
  return inst.points.every((p) => p.complete);
}

describe("skipCurrentPassItem", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("decides every node of the bad animal and moves to the next one", () => {
    const { labels, skeleton, video } = setupProject([0, 1]);
    const { workList } = enterSweep(labels, skeleton);
    expect(workList.length).toBe(2);
    expect(useAppStore.getState().passCursor).toEqual({ passIdx: 0, itemIdx: 0, nodeIdx: 0 });

    expect(skipCurrentPassItem()).toBe(true);

    const bad = labels.find({ video, frameIdx: 0 })[0].instances[0];
    expect(fullyDecided(bad)).toBe(true);
    // Declined, not invented: no point got a location.
    expect(bad.points.every((p) => !p.visible && !Number.isFinite(p.xy[0]))).toBe(true);

    // The cursor moved to the NEXT animal's first node, and the view followed.
    expect(useAppStore.getState().passCursor).toEqual({ passIdx: 0, itemIdx: 1, nodeIdx: 0 });
    expect(useAppStore.getState().frameIdx).toBe(1);
    // The next animal is untouched.
    expect(fullyDecided(labels.find({ video, frameIdx: 1 })[0].instances[0])).toBe(false);
  });

  it("keeps the centroid — the locator's true positive is not thrown away", () => {
    const { labels, skeleton, video } = setupProject([0, 1]);
    enterSweep(labels, skeleton);
    skipCurrentPassItem();

    const lf = labels.find({ video, frameIdx: 0 })[0];
    expect(lf.centroids.length).toBe(1);
    expect(lf.centroids[0].xy).toEqual([100, 200]);
    expect(lf.instances.length).toBe(1); // the paired pose is kept too
  });

  it("marks the project dirty and is undoable", () => {
    const { labels, skeleton, video } = setupProject([0, 1]);
    enterSweep(labels, skeleton);
    skipCurrentPassItem();
    expect(useAppStore.getState().hasChanges).toBe(true);

    commandContext.undo();
    const restored = labels.find({ video, frameIdx: 0 })[0].instances[0];
    expect(fullyDecided(restored)).toBe(false);
  });

  it("does not snap back to an earlier node the labeler chose to leave with `s`", () => {
    const { labels, skeleton } = setupProject([0, 1, 2]);
    enterSweep(labels, skeleton);
    // `s` past animal 0's two nodes, leaving both undecided, landing on animal 1.
    useAppStore.getState().passAdvance();
    useAppStore.getState().passAdvance();
    expect(useAppStore.getState().passCursor).toEqual({ passIdx: 0, itemIdx: 1, nodeIdx: 0 });

    skipCurrentPassItem();
    // Forward to animal 2 — NOT back to animal 0, whose nodes are still open.
    expect(useAppStore.getState().passCursor).toEqual({ passIdx: 0, itemIdx: 2, nodeIdx: 0 });
  });

  it("ends the sweep when the skipped animal was the last thing left", () => {
    const { labels, skeleton } = setupProject([0]);
    enterSweep(labels, skeleton);
    expect(skipCurrentPassItem()).toBe(true);
    const s = useAppStore.getState();
    expect(s.passCursor).toBeNull(); // the "complete" state
    expect(s.labelingMode).toBe("keypointPass"); // mode stays for the done HUD
  });

  it("bails without mutating when the item's frame can't be framed", () => {
    // The stub video reports 10 frames, so setFrameIdx clamps to <= 9: an item at
    // frame 20 can never be landed on, and frame 9 holds a DIFFERENT animal that
    // must not be written off in its place.
    const { labels, skeleton, video } = setupProject([9, 20]);
    const { workList } = enterSweep(labels, skeleton);
    // Park the cursor on the unreachable item (frame 20 sorts last).
    expect(workList[1].frameIdx).toBe(20);
    useAppStore.getState().passAdvance();
    useAppStore.getState().passAdvance();
    expect(useAppStore.getState().passCursor?.itemIdx).toBe(1);

    expect(skipCurrentPassItem()).toBe(false);
    expect(fullyDecided(labels.find({ video, frameIdx: 20 })[0].instances[0])).toBe(false);
    expect(fullyDecided(labels.find({ video, frameIdx: 9 })[0].instances[0])).toBe(false);
  });

  it("is inert outside the sweep", () => {
    const { labels } = setupProject([0]);
    useAppStore.getState().setLabels(labels);
    expect(useAppStore.getState().labelingMode).toBe("select");
    expect(skipCurrentPassItem()).toBe(false);
  });
});

describe("a skipped instance survives a save/reload", () => {
  it("round-trips through the SLP, so resume still walks past it next session", async () => {
    // The claim `markInstanceDecided` rests on: `complete` is a real, persisted
    // SLP point column, so the skip needs no side-table of its own.
    const skeleton = new Skeleton({ nodes: [...NODE_NAMES], name: "test" });
    const video = new Video({
      filename: "a.mp4",
      backendMetadata: { shape: [10, 480, 640, 3] },
      openBackend: false,
    });
    const bad = Instance.empty({ skeleton });
    const partly = Instance.empty({ skeleton }); // one node placed, rest still open
    partly.points[0].xy = [5, 6];
    partly.points[0].visible = true;
    partly.points[0].complete = true;
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.centroids.push(new UserCentroid({ x: 1, y: 2 }), new UserCentroid({ x: 3, y: 4 }));
    lf.instances.push(bad, partly);
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    labels.labeledFrames.push(lf);

    markInstanceDecided(bad);

    const bytes = await saveSlpToBytes(labels);
    const reloaded = await loadSlp(bytes.buffer as ArrayBuffer, { openVideos: false });
    const rlf = reloaded.labeledFrames[0];

    // The skip held: all decided, none visible, nothing invented.
    expect(rlf.instances[0].points.every((p) => p.complete)).toBe(true);
    expect(rlf.instances[0].points.every((p) => !p.visible)).toBe(true);
    // Its neighbour is untouched — still one decided node, three open.
    expect(rlf.instances[1].points.map((p) => p.complete)).toEqual([true, false, false]);
    // Both centroids are still there: the pairing (and the locator's labels) hold.
    expect(rlf.centroids.length).toBe(2);
    expect(rlf.instances.length).toBe(2);
  });
});
