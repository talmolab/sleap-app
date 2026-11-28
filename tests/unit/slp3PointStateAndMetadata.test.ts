/**
 * Unit tests for SLP 3.0 4-state keypoints (`SetPointState`), record metadata
 * (`SetRecordMetadata`), `frameHasContent`, autosave journal fidelity, undo/redo,
 * View-only guards, and real `sleap-io.js@0.6.0-alpha.0` SLP 3.0 round-trips.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  PredictedBoundingBox,
  PredictedInstance,
  Skeleton,
  UserBoundingBox,
  Video,
  loadSlp,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import {
  commandContext,
  CopyInstance,
  PasteInstance,
  SetPointState,
  SetRecordMetadata,
  ToggleNodeVisibility,
} from "@/commands";
import {
  applyPointState,
  countPointStates,
  formatPointStateSummary,
  getPointState,
  hasPointCoords,
  nextCyclePointState,
  nextUnplacedNodeForward,
} from "@/lib/pointState";
import { frameHasContent } from "@/lib/frameLabeling";
import {
  applyDeltas,
  buildBaseIndex,
  decodeJournal,
  encodeFrameDelta,
  frameDeltaToRecord,
} from "@/lib/autosaveJournal";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function makeTestProject() {
  const skeleton = new Skeleton({
    nodes: ["nose", "left_ear", "right_ear", "tail_base"],
    name: "mouse",
  });
  const video = new Video({
    filename: "clip.mp4",
    backendMetadata: { shape: [20, 480, 640, 3] },
    openBackend: false,
  });
  const userInst = new Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      { xy: [30, 40], visible: false, complete: true },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false, labeled: false },
    ],
  });
  const predInst = new PredictedInstance({
    skeleton,
    score: 0.9,
    points: [
      { xy: [100, 120], visible: true, complete: false, score: 0.95 },
      { xy: [110, 130], visible: true, complete: false, score: 0.85 },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false, score: 0 },
      { xy: [Number.NaN, Number.NaN], visible: false, complete: false, score: 0, labeled: false },
    ],
  });
  const userBox = new UserBoundingBox({ x1: 5, y1: 10, x2: 60, y2: 70, category: "body" });
  const predBox = new PredictedBoundingBox({
    x1: 90,
    y1: 100,
    x2: 150,
    y2: 160,
    score: 0.88,
    category: "body",
  });
  const lf = new LabeledFrame({ video, frameIdx: 0, instances: [userInst, predInst] });
  lf.bboxes = [userBox, predBox];
  const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });

  useAppStore.setState(useAppStore.getInitialState());
  commandContext.reset();
  useAppStore.setState({
    labels,
    video,
    skeleton,
    frameIdx: 0,
    labeledFrame: lf,
    instance: userInst,
  });

  return { labels, video, skeleton, lf, userInst, predInst, userBox, predBox };
}

function makeViewOnly(labels: Labels) {
  labels.sourceFormat = Object.freeze({
    formatId: 3,
    access: "view",
    labelsPath: "test.slp",
    summary: {
      formatId: 3,
      unlabeledPoints: 1,
      unlabeledUserPoints: 1,
      unlabeledPredictedPoints: 0,
      metadataKeys: { instances: [], frames: [], bboxes: [] },
      unknownColumns: [],
      unreadTables: ["label_images"],
      lossless: false,
    },
  });
}

describe("pointState pure helpers", () => {
  it("classifies and counts all 4 states accurately", () => {
    const { userInst } = makeTestProject();
    expect(getPointState(userInst.points[0])).toBe("visible");
    expect(getPointState(userInst.points[1])).toBe("occluded");
    expect(getPointState(userInst.points[2])).toBe("absent");
    expect(getPointState(userInst.points[3])).toBe("unlabeled");

    expect(hasPointCoords(userInst.points[0])).toBe(true);
    expect(hasPointCoords(userInst.points[1])).toBe(true);
    expect(hasPointCoords(userInst.points[2])).toBe(false);
    expect(hasPointCoords(userInst.points[3])).toBe(false);

    const counts = countPointStates(userInst);
    expect(counts).toEqual({ visible: 1, occluded: 1, absent: 1, unlabeled: 1, total: 4 });
    expect(formatPointStateSummary(counts)).toContain("1 visible");
    expect(formatPointStateSummary(counts)).toContain("1 occluded");
    expect(formatPointStateSummary(counts)).toContain("1 absent");
    expect(formatPointStateSummary(counts)).toContain("1 unlabeled (ignored in training)");
  });

  it("refuses visible/occluded transitions on NaN points and preserves coords when marking placed points unlabeled", () => {
    const p = { xy: [Number.NaN, Number.NaN] as [number, number], visible: false, complete: false, labeled: false };
    expect(applyPointState(p, "visible")).toBe(false);
    expect(applyPointState(p, "occluded")).toBe(false);
    expect(getPointState(p)).toBe("unlabeled");
    expect(hasPointCoords(p)).toBe(false);

    // Placed point marked unlabeled keeps finite coords so it stays visible/interactive.
    const placed = { xy: [12, 34] as [number, number], visible: true, complete: true, labeled: true };
    expect(applyPointState(placed, "unlabeled")).toBe(true);
    expect(getPointState(placed)).toBe("unlabeled");
    expect(hasPointCoords(placed)).toBe(true);
    expect(placed.xy).toEqual([12, 34]);
    expect(placed.visible).toBe(false);
    expect(placed.labeled).toBe(false);

    // Can transition back to visible/occluded without re-placing.
    expect(applyPointState(placed, "visible")).toBe(true);
    expect(getPointState(placed)).toBe("visible");
    expect(placed.xy).toEqual([12, 34]);

    // 3-state cycle helper: visible -> occluded -> unlabeled -> visible.
    expect(nextCyclePointState("visible")).toBe("occluded");
    expect(nextCyclePointState("occluded")).toBe("unlabeled");
    expect(nextCyclePointState("unlabeled")).toBe("visible");
    expect(nextCyclePointState("absent")).toBe("visible");
  });

  it("nextUnplacedNodeForward steps strictly forward without looping", () => {
    const { userInst } = makeTestProject();
    expect(nextUnplacedNodeForward(userInst.points, 0)).toBe(2);
    expect(nextUnplacedNodeForward(userInst.points, 2)).toBe(3);
    expect(nextUnplacedNodeForward(userInst.points, 3)).toBe(-1);
  });
});

describe("SetPointState and ToggleNodeVisibility commands", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("transitions across all 4 states cleanly with undo/redo", async () => {
    const { lf } = makeTestProject();
    const getPt = (idx: number) => useAppStore.getState().labeledFrame!.instances[0].points[idx];

    // Visible -> Occluded (preserves coords & labeled=true)
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
      state: "occluded",
    });
    expect(getPointState(getPt(0))).toBe("occluded");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).labeled).toBe(true);

    // Occluded -> Visible (preserves coords, complete=true)
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
      state: "visible",
    });
    expect(getPointState(getPt(0))).toBe("visible");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).complete).toBe(true);

    // Visible -> Unlabeled (preserves finite coords in memory, labeled=false)
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
      state: "unlabeled",
    });
    expect(getPointState(getPt(0))).toBe("unlabeled");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).visible).toBe(false);
    expect(getPt(0).labeled).toBe(false);

    // Unlabeled -> Absent (clears coords to NaN, labeled=true)
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
      state: "absent",
    });
    expect(getPointState(getPt(0))).toBe("absent");
    expect(Number.isNaN(getPt(0).xy[0])).toBe(true);
    expect(getPt(0).labeled).toBe(true);

    // Undo back through Absent -> Unlabeled (restores coords!) -> Visible
    commandContext.undo();
    expect(getPointState(getPt(0))).toBe("unlabeled");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).labeled).toBe(false);

    commandContext.undo();
    expect(getPointState(getPt(0))).toBe("visible");
    expect(getPt(0).xy).toEqual([10, 20]);

    // Redo returns to Unlabeled (with preserved coords)
    commandContext.redo();
    expect(getPointState(getPt(0))).toBe("unlabeled");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).labeled).toBe(false);

    // Predicted instance is never mutated by SetPointState
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 1, nodeIdx: 0 }],
      state: "unlabeled",
    });
    expect(getPointState(lf.instances[1].points[0])).toBe("visible");
  });

  it("ToggleNodeVisibility cycles placed points visible -> occluded -> unlabeled -> visible and ignores NaN points", async () => {
    makeTestProject();
    const getPt = (idx: number) => useAppStore.getState().labeledFrame!.instances[0].points[idx];

    // Unplaced (NaN) unlabeled point is ignored.
    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [{ instanceIdx: 0, nodeIdx: 3 }],
    });
    expect(getPointState(getPt(3))).toBe("unlabeled");
    expect(getPt(3).visible).toBe(false);

    // Placed visible point cycles: visible -> occluded -> unlabeled -> visible,
    // preserving [10, 20] coordinates throughout!
    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
    });
    expect(getPointState(getPt(0))).toBe("occluded");
    expect(getPt(0).xy).toEqual([10, 20]);

    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
    });
    expect(getPointState(getPt(0))).toBe("unlabeled");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).labeled).toBe(false);

    await commandContext.execute(ToggleNodeVisibility, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
    });
    expect(getPointState(getPt(0))).toBe("visible");
    expect(getPt(0).xy).toEqual([10, 20]);
    expect(getPt(0).labeled).toBe(true);
  });

  it("refuses SetPointState on View-only projects", async () => {
    const { labels, userInst } = makeTestProject();
    makeViewOnly(labels);

    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 0 }],
      state: "unlabeled",
    });
    expect(getPointState(userInst.points[0])).toBe("visible");
    expect(userInst.points[0].xy).toEqual([10, 20]);
  });

  it("CopyInstance + PasteInstance preserve all 4 point states and metadata", async () => {
    const { userInst, video } = makeTestProject();
    userInst.metadata = { quality: "gold", score_override: 1 };

    await commandContext.execute(CopyInstance);
    useAppStore.setState({ video, frameIdx: 2, labeledFrame: null, instance: null });
    await commandContext.execute(PasteInstance);

    const pasted = useAppStore.getState().labeledFrame!.instances[0];
    expect(pasted.points.map(getPointState)).toEqual([
      "visible",
      "occluded",
      "absent",
      "unlabeled",
    ]);
    expect(pasted.metadata).toEqual({ quality: "gold", score_override: 1 });
  });
});

describe("SetRecordMetadata and frameHasContent", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("adds, updates, and clears frame metadata on an empty frame with undo/redo", async () => {
    const { labels, video } = makeTestProject();
    // Move to frame 5 which has no LabeledFrame yet
    useAppStore.setState({ frameIdx: 5, labeledFrame: null, instance: null });

    await commandContext.execute(SetRecordMetadata, {
      target: "frame",
      metadata: { "  trial  ": "baseline", weight: 2.5, reviewed: true, "": "drop", bad: Number.NaN },
    });

    const created = labels.find({ video, frameIdx: 5 })[0];
    expect(created).toBeDefined();
    expect(created.metadata).toEqual({ trial: "baseline", weight: 2.5, reviewed: true });
    expect(frameHasContent(created)).toBe(true);
    expect(useAppStore.getState().labeledFrame).toBe(created);

    // Clear all frame metadata
    await commandContext.execute(SetRecordMetadata, {
      target: "frame",
      metadata: {},
    });
    expect(created.metadata).toEqual({});
    expect(frameHasContent(created)).toBe(false);

    // Undo restores metadata
    commandContext.undo();
    const afterUndoClear = labels.find({ video, frameIdx: 5 })[0];
    expect(afterUndoClear.metadata).toEqual({ trial: "baseline", weight: 2.5, reviewed: true });
    expect(frameHasContent(afterUndoClear)).toBe(true);

    // Undo creation removes the empty frame
    commandContext.undo();
    expect(labels.find({ video, frameIdx: 5 }).length).toBe(0);

    // Redo recreates it with metadata
    commandContext.redo();
    const afterRedo = labels.find({ video, frameIdx: 5 })[0];
    expect(afterRedo.metadata).toEqual({ trial: "baseline", weight: 2.5, reviewed: true });
  });

  it("edits and clears instance and bbox metadata with undo/redo", async () => {
    makeTestProject();

    await commandContext.execute(SetRecordMetadata, {
      target: "instance",
      index: 0,
      metadata: { animal_id: "M01", age_days: 42 },
    });
    expect(useAppStore.getState().labeledFrame!.instances[0].metadata).toEqual({
      animal_id: "M01",
      age_days: 42,
    });

    await commandContext.execute(SetRecordMetadata, {
      target: "bbox",
      index: 0,
      metadata: { occluded_box: true },
    });
    expect(useAppStore.getState().labeledFrame!.bboxes[0].metadata).toEqual({
      occluded_box: true,
    });

    // Clear bbox metadata
    await commandContext.execute(SetRecordMetadata, {
      target: "bbox",
      index: 0,
      metadata: {},
    });
    expect(useAppStore.getState().labeledFrame!.bboxes[0].metadata).toEqual({});

    // Undo restores bbox metadata
    commandContext.undo();
    expect(useAppStore.getState().labeledFrame!.bboxes[0].metadata).toEqual({
      occluded_box: true,
    });

    // Undo again clears bbox metadata (back to initial)
    commandContext.undo();
    expect(useAppStore.getState().labeledFrame!.bboxes[0].metadata).toEqual({});
  });

  it("refuses SetRecordMetadata on View-only projects", async () => {
    const { labels, lf, userInst, userBox } = makeTestProject();
    makeViewOnly(labels);

    await commandContext.execute(SetRecordMetadata, {
      target: "frame",
      metadata: { note: "blocked" },
    });
    await commandContext.execute(SetRecordMetadata, {
      target: "instance",
      index: 0,
      metadata: { note: "blocked" },
    });
    await commandContext.execute(SetRecordMetadata, {
      target: "bbox",
      index: 0,
      metadata: { note: "blocked" },
    });

    expect(lf.metadata).toEqual({});
    expect(userInst.metadata).toEqual({});
    expect(userBox.metadata).toEqual({});
  });
});

describe("Autosave journal & real sleap-io.js 0.6.0-alpha.0 SLP 3.0 round-trip", () => {
  it("autosave journal preserves all 4 states and clears deleted frame metadata", () => {
    const { labels, lf, userInst, userBox } = makeTestProject();
    lf.metadata = { session: "S1" };
    userInst.metadata = { coder: "alice" };
    userBox.metadata = { verified: true };

    const index = buildBaseIndex(labels);
    const rec1 = frameDeltaToRecord(encodeFrameDelta(lf, index));

    // Now clear frame metadata and journal a second delta
    lf.metadata = {};
    const rec2 = frameDeltaToRecord(encodeFrameDelta(lf, index));

    // Replay rec1 then rec2 onto a fresh base whose frame 0 had stale metadata
    const base = makeTestProject().labels;
    base.labeledFrames[0].metadata = { session: "STALE" };
    const combined = new Uint8Array(rec1.length + rec2.length);
    combined.set(rec1, 0);
    combined.set(rec2, rec1.length);
    const { deltas, truncatedTail } = decodeJournal(combined);
    expect(truncatedTail).toBe(false);
    applyDeltas(base, deltas);

    const recovered = base.labeledFrames[0];
    expect(recovered.metadata).toEqual({});
    expect(recovered.instances[0].points.map(getPointState)).toEqual([
      "visible",
      "occluded",
      "absent",
      "unlabeled",
    ]);
    expect(recovered.instances[0].metadata).toEqual({ coder: "alice" });
    expect(recovered.bboxes[0].metadata).toEqual({ verified: true });
  });

  it("round-trips command-edited 4-state points and record metadata through real SLP 3.0 bytes", async () => {
    const { labels } = makeTestProject();

    // Mutate via our commands
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 1 }],
      state: "occluded",
    });
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 2 }],
      state: "absent",
    });
    await commandContext.execute(SetPointState, {
      nodes: [{ instanceIdx: 0, nodeIdx: 3 }],
      state: "unlabeled",
    });
    await commandContext.execute(SetRecordMetadata, {
      target: "frame",
      metadata: { stimulus: "tone", trial: 7, valid: true },
    });
    await commandContext.execute(SetRecordMetadata, {
      target: "instance",
      index: 0,
      metadata: { strain: "C57BL/6", mass_g: 24.5 },
    });
    await commandContext.execute(SetRecordMetadata, {
      target: "bbox",
      index: 0,
      metadata: { source: "manual", crowd: false },
    });

    const bytes = await saveSlpToBytes(labels, { slpVersion: "auto" });
    const buf = bytes.slice().buffer;
    const reloaded = await loadSlp(buf, { openVideos: false });

    expect(reloaded.sourceFormat?.formatId).toBe(3);
    const rlf = reloaded.labeledFrames[0];
    const rinst = rlf.instances[0];
    expect(rinst.points.map(getPointState)).toEqual([
      "visible",
      "occluded",
      "absent",
      "unlabeled",
    ]);
    expect(rinst.points[0].xy).toEqual([10, 20]);
    expect(rinst.points[1].xy).toEqual([30, 40]);
    expect(rinst.points[2].labeled).toBe(true);
    expect(rinst.points[3].labeled).toBe(false);
    expect(rlf.metadata).toEqual({ stimulus: "tone", trial: 7, valid: true });
    expect(rinst.metadata).toEqual({ strain: "C57BL/6", mass_g: 24.5 });
    expect(rlf.bboxes[0].metadata).toEqual({ source: "manual", crowd: false });
  });
});
