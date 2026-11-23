/**
 * Undo/redo keeps every annotation a labeled frame carries (#487 part 2).
 *
 * An undo snapshot used to keep only a frame's instances and negative flag, so
 * undoing a multi-frame command (Delete Predictions, ...) rebuilt every frame
 * without its centroids, boxes, masks, label images and ROIs — and dropped the
 * instances' tracking score, identity and category, and the links between
 * them. These tests run every undoable command over a project holding every
 * annotation type, then check undo restores the project exactly and redo
 * re-applies the command exactly.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import type { Command } from "@/commands/types";
import { useAppStore } from "@/stores/appStore";
import {
  AddInstancesFromAllPredictions,
  AddInstancesFromAllPredictionsInProject,
  ConvertPredictionToInstance,
  DeleteAllPredictions,
  DeleteFramePredictions,
  DeleteSelectedInstance,
  MergePredictions,
  SetNodes,
  ToggleNegativeFrame,
} from "@/commands/editCommands";
import {
  DeleteInstancesByType,
  DeletePredictionsByArea,
  DeletePredictionsByMaxCount,
  DeletePredictionsByRange,
  DeletePredictionsByScore,
  DeletePredictionsByTrack,
  DeletePredictionsFromClip,
  DeletePredictionsOnLabeledFrames,
} from "@/commands/fileCommands";
import {
  AcceptAllBboxes,
  AcceptFrameBboxes,
  AddBbox,
  BboxesFromPoses,
  DeleteBbox,
  DeletePredictedBboxes,
  SetBboxGeometry,
} from "@/commands/bboxCommands";
import {
  DeleteAllTracks,
  DeleteInstanceAndTrack,
  DeleteTrack,
  DeleteUnusedTracks,
  SetInstanceTrack,
} from "@/commands/trackCommands";
import { AddNodeCommand, installSkeletonUndoInterceptor } from "@/commands/skeletonCommands";
import {
  Identity,
  Instance,
  LabeledFrame,
  Labels,
  PredictedBoundingBox,
  PredictedCentroid,
  PredictedInstance,
  PredictedSegmentationMask,
  Skeleton,
  Track,
  UserBoundingBox,
  UserCentroid,
  UserLabelImage,
  UserROI,
  UserSegmentationMask,
  Video,
  encodeRle,
} from "@talmolab/sleap-io.js";

/** A 4×4 mask, fully on. */
const rle = () => encodeRle(new Uint8Array(16).fill(1), 4, 4);

/**
 * A project with every annotation type, linked the ways real files link them:
 * frame 0 has a user instance made from a prediction, plus a box, centroid,
 * predicted + user mask, label image and ROI tied to it; frame 3 is a negative
 * frame that still has a centroid; frame 5 has annotations, a prediction and a
 * user instance made from it; frame 7 has only a prediction (Delete
 * Predictions empties and drops it). With `crossFrameLink`, frame 5's user
 * instance links to frame 0's prediction instead — SLEAP never does this, but
 * an all-frames restore must still keep such a link.
 */
function setup({ crossFrameLink = false } = {}) {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "mouse" });
  const video = new Video({
    filename: "v.mp4",
    backendMetadata: { shape: [10, 64, 64, 1] },
    openBackend: false,
  });
  const t1 = new Track("t1");
  const t2 = new Track("t2");
  const mouse = new Identity({ name: "mouse-A" });

  const pred = (xy: number[][], score: number, track: Track | null) => {
    const p = PredictedInstance.fromArray(xy, skeleton);
    p.score = score;
    p.track = track;
    p.trackingScore = 0.9;
    return p;
  };
  const p0 = pred([[1, 2], [3, 4]], 0.2, t1);
  p0.category = "mouse";
  p0.categoryScore = 0.6;
  const p0b = pred([[20, 20], [30, 30]], 0.95, t2);
  const u0 = new Instance({
    skeleton,
    points: [
      { xy: [1.5, 2.5], visible: true, complete: true, name: "a" },
      { xy: [3.5, 4.5], visible: false, complete: false, name: "b" },
    ],
    track: t1,
    fromPredicted: p0,
    trackingScore: 0.7,
  });
  u0.identity = mouse;
  u0.identityScore = 0.5;
  u0.category = "mouse";
  u0.categoryScore = 0.8;

  const predMask = new PredictedSegmentationMask({
    rleCounts: rle(),
    height: 4,
    width: 4,
    score: 0.4,
    instance: p0,
    track: t1,
  });
  const userMask = new UserSegmentationMask({
    rleCounts: rle(),
    height: 4,
    width: 4,
    instance: u0,
    track: t1,
    fromPredicted: predMask,
    scale: [2, 2],
    offset: [1, 1],
  });
  const userBox = new UserBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 6, instance: u0, track: t1, category: "mouse" });
  userBox.identity = mouse;
  const predBox = new PredictedBoundingBox({ x1: 18, y1: 18, x2: 32, y2: 32, score: 0.3, instance: p0b, track: t2 });
  const centroid = new UserCentroid({ x: 2, y: 3, instance: u0, track: t1, category: "mouse" });
  const labelImage = new UserLabelImage({
    data: new Int32Array(16).fill(1),
    height: 4,
    width: 4,
    objects: new Map([[1, { track: t1, category: "mouse", name: "m1", instance: u0 }]]),
  });
  const roi = new UserROI({
    geometry: { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] },
    instance: u0,
    track: t2,
    name: "arena",
  });

  const frame0 = new LabeledFrame({
    video,
    frameIdx: 0,
    instances: [u0, p0, p0b],
    bboxes: [userBox, predBox],
    centroids: [centroid],
    masks: [predMask, userMask],
    labelImages: [labelImage],
    rois: [roi],
  });
  const frame3 = new LabeledFrame({
    video,
    frameIdx: 3,
    isNegative: true,
    centroids: [new UserCentroid({ x: 9, y: 9 })],
  });
  const p5 = pred([[40, 40], [41, 41]], 0.1, t2);
  const u5 = new Instance({
    skeleton,
    points: [
      { xy: [10, 10], visible: true, complete: true, name: "a" },
      { xy: [11, 11], visible: true, complete: true, name: "b" },
    ],
    track: null,
    fromPredicted: crossFrameLink ? p0 : p5,
  });
  const frame5 = new LabeledFrame({
    video,
    frameIdx: 5,
    instances: [u5, p5],
    centroids: [new PredictedCentroid({ x: 40, y: 40, score: 0.2, instance: p5, track: t2 })],
    rois: [new UserROI({ geometry: { type: "Point", coordinates: [5, 5] } })],
  });
  const frame7 = new LabeledFrame({
    video,
    frameIdx: 7,
    instances: [pred([[50, 50], [51, 51]], 0.05, t2)],
  });

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks: [t1, t2],
    labeledFrames: [frame0, frame3, frame5, frame7],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.setState({ video, frameIdx: 0, labeledFrame: frame0, instance: null });
  return { labels, video, frame0, u0, p0 };
}

const ANNOTATION_CLASSES = [
  "Centroid",
  "BoundingBox",
  "SegmentationMask",
  "LabelImage",
  "ROI",
];

/**
 * A plain-data picture of the whole project: every frame field and every own
 * field of every instance and annotation. Links become ids into the project
 * ("f0.instances[0]"); a link to an object no longer in the project becomes
 * "STALE", so a restore that leaves a box linked to a dropped instance fails.
 */
function fingerprint(labels: Labels): unknown {
  const ids = new Map<object, string>();
  for (const lf of labels.labeledFrames) {
    for (const [key, list] of Object.entries(lf)) {
      if (!Array.isArray(list)) continue;
      list.forEach((obj, i) => ids.set(obj as object, `f${lf.frameIdx}.${key}[${i}]`));
    }
  }
  const isLinkable = (v: object) =>
    v instanceof Instance ||
    ANNOTATION_CLASSES.some((c) => {
      for (let p = Object.getPrototypeOf(v); p; p = Object.getPrototypeOf(p)) {
        if (p.constructor?.name?.endsWith(c)) return true;
      }
      return false;
    });
  const describe = (v: unknown, depth: number): unknown => {
    if (v === undefined) return null; // an unset and a null track mean the same
    if (typeof v === "number" && Number.isNaN(v)) return "NaN";
    if (typeof v !== "object" || v === null) return v;
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
    if (Array.isArray(v)) return v.map((x) => describe(x, depth + 1));
    if (v instanceof Map) return [...v].map(([k, x]) => [k, describe(x, depth + 1)]);
    if (v instanceof Track) return `track:${v.name}`;
    if (v instanceof Skeleton) return `skeleton:${v.name}:${v.nodes.length}`;
    if (v instanceof Identity) return `identity:${v.name}`;
    if (v instanceof Video) return `video:${v.filename}`;
    if (depth > 0) {
      const id = ids.get(v);
      if (id) return `@${id}`;
      if (isLinkable(v)) return "STALE";
    }
    const out: Record<string, unknown> = { class: v.constructor?.name };
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith("_dataCache")) continue; // a decode cache, not data
      out[k] = describe(x, depth + 1);
    }
    return out;
  };
  return [...labels.labeledFrames]
    .sort((a, b) => a.frameIdx - b.frameIdx)
    .map((lf) => {
      const frame: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(lf)) {
        frame[key] = Array.isArray(value) ? value.map((x) => describe(x, 0)) : describe(value, 1);
      }
      return frame;
    });
}

type Case = [string, Command, (env: ReturnType<typeof setup>) => Record<string, unknown> | undefined];

describe("undo/redo round-trips every annotation type (#487)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
    installSkeletonUndoInterceptor(ctx);
  });

  /** Run `command`, then check undo → redo → undo each lands exactly where it should. */
  async function roundTrip(command: Command, params: Case[2], select?: (env: ReturnType<typeof setup>) => void) {
    const env = setup();
    select?.(env);
    const before = fingerprint(env.labels);
    await ctx.execute(command, params(env));
    const after = fingerprint(env.labels);
    // The command must actually change something, or the test proves nothing.
    expect(after).not.toEqual(before);
    expect(ctx.canUndo).toBe(true);

    ctx.undo();
    expect(fingerprint(env.labels)).toEqual(before);
    ctx.redo();
    expect(fingerprint(env.labels)).toEqual(after);
    // Undo again: the snapshot must still be intact after being restored once.
    ctx.undo();
    expect(fingerprint(env.labels)).toEqual(before);
  }

  // Commands that touch many frames (an all-frames or scoped snapshot).
  const multiFrame: Case[] = [
    ["Delete All Predictions", DeleteAllPredictions, () => undefined],
    ["Delete Predictions by score", DeletePredictionsByScore, () => ({ threshold: 0.5 })],
    ["Delete Predictions outside a frame range", DeletePredictionsByRange, () => ({ startFrame: 4, endFrame: 6 })],
    ["Delete Predictions from clip", DeletePredictionsFromClip, () => ({ startFrame: 0, endFrame: 9 })],
    ["Delete Predictions from area", DeletePredictionsByArea, () => ({ x1: 0, y1: 0, x2: 64, y2: 64 })],
    ["Delete Predictions beyond max instances", DeletePredictionsByMaxCount, () => ({ maxInstances: 0 })],
    [
      "Delete Predictions on user-labeled frames",
      DeletePredictionsOnLabeledFrames,
      () => ({ allVideos: true, unlinkedOnly: false }),
    ],
    ["Delete Predictions by track", DeletePredictionsByTrack, () => ({ trackName: "t2" })],
    ["Delete Instances by type (all)", DeleteInstancesByType, () => ({ instanceType: "all" })],
    ["Accept all predictions in the project", AddInstancesFromAllPredictionsInProject, () => undefined],
    ["Accept all predicted boxes", AcceptAllBboxes, () => ({ minScore: 0 })],
    ["Delete predicted boxes", DeletePredictedBboxes, () => undefined],
    ["Boxes from Poses (project)", BboxesFromPoses, () => ({ scope: "project", padding: 2 })],
    ["Delete Track", DeleteTrack, () => ({ trackIdx: 1 })],
    ["Delete All Tracks", DeleteAllTracks, () => undefined],
    [
      "Merge inference results (clear all)",
      MergePredictions,
      ({ video }) => ({
        predictions: new Labels({ videos: [video], skeletons: [], labeledFrames: [] }),
        mode: "clear_all",
      }),
    ],
    ["Add Node (skeleton edit)", AddNodeCommand, () => ({ name: "c" })],
  ];

  for (const [label, command, params] of multiFrame) {
    it(`${label}: undo restores every annotation, redo re-applies`, async () => {
      await roundTrip(command, params);
    });
  }

  it("Set Instance Track with propagation (scoped snapshot)", async () => {
    await roundTrip(SetInstanceTrack, () => ({ trackIdx: 1 }), ({ u0 }) =>
      useAppStore.setState({ instance: u0, propagateTrackLabels: true }),
    );
  });

  it("Delete Instance and Track (scoped snapshot)", async () => {
    await roundTrip(DeleteInstanceAndTrack, () => undefined, ({ u0 }) =>
      useAppStore.setState({ instance: u0 }),
    );
  });

  // Commands that edit the current frame (the default single-frame snapshot).
  const singleFrame: Case[] = [
    ["Mark Frame as Negative", ToggleNegativeFrame, () => undefined],
    ["Delete Frame Predictions", DeleteFramePredictions, () => undefined],
    ["Convert a prediction", ConvertPredictionToInstance, () => ({ instanceIdx: 1 })],
    ["Accept all predictions on the frame", AddInstancesFromAllPredictions, () => undefined],
    ["Set Nodes", SetNodes, ({ u0 }) => ({ instance: u0, nodes: { 0: [7, 7], 1: null } })],
    ["Add Box", AddBbox, () => ({ x1: 1, y1: 1, x2: 9, y2: 9 })],
    ["Move Box", SetBboxGeometry, () => ({ index: 0, x1: 2, y1: 2, x2: 8, y2: 8 })],
    ["Delete Box", DeleteBbox, () => ({ index: 0 })],
    ["Accept Frame Boxes", AcceptFrameBboxes, () => ({ minScore: 0 })],
  ];

  for (const [label, command, params] of singleFrame) {
    it(`${label}: undo restores the frame's annotations, redo re-applies`, async () => {
      await roundTrip(command, params);
    });
  }

  it("Delete Selected Instance: undo restores it and every link to it", async () => {
    await roundTrip(DeleteSelectedInstance, () => undefined, ({ u0 }) =>
      useAppStore.setState({ instance: u0 }),
    );
  });
});

describe("undo restores annotations exactly (#487)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  const frame0 = (labels: Labels) => labels.labeledFrames.find((lf) => lf.frameIdx === 0)!;

  // The issue's repro: Delete Predictions, then undo, used to lose the centroid.
  it("Delete Predictions + undo keeps the user centroid, box, masks, label image and ROI", async () => {
    const { labels } = setup();
    await ctx.execute(DeleteAllPredictions);
    expect(frame0(labels).instances.some((i) => i instanceof PredictedInstance)).toBe(false);

    ctx.undo();
    const lf = frame0(labels);
    expect(lf.instances.filter((i) => i instanceof PredictedInstance)).toHaveLength(2);
    expect(lf.centroids).toHaveLength(1);
    expect(lf.bboxes).toHaveLength(2);
    expect(lf.masks).toHaveLength(2);
    expect(lf.labelImages).toHaveLength(1);
    expect(lf.rois).toHaveLength(1);
    expect(labels.labeledFrames.find((f) => f.frameIdx === 3)?.centroids).toHaveLength(1);
  });

  // Fields the old snapshot dropped from every instance on undo.
  it("keeps an instance's tracking score, identity, category and point scores", async () => {
    const { labels } = setup();
    await ctx.execute(DeleteAllPredictions);
    ctx.undo();
    const [u0, p0] = frame0(labels).instances;
    expect(u0.trackingScore).toBe(0.7);
    expect(u0.identity?.name).toBe("mouse-A");
    expect(u0.identityScore).toBe(0.5);
    expect(u0.category).toBe("mouse");
    expect(u0.categoryScore).toBe(0.8);
    expect(u0.points[1].visible).toBe(false);
    expect(p0).toBeInstanceOf(PredictedInstance);
    expect((p0 as PredictedInstance).score).toBe(0.2);
    expect(p0.trackingScore).toBe(0.9);
    expect(p0.category).toBe("mouse");
  });

  // Links must point at the restored objects, not the ones undo replaced.
  it("re-points every link at the restored objects", async () => {
    const { labels } = setup({ crossFrameLink: true });
    await ctx.execute(DeleteAllPredictions);
    ctx.undo();
    const lf = frame0(labels);
    const [u0, p0, p0b] = lf.instances;
    expect(u0.fromPredicted).toBe(p0 as PredictedInstance);
    expect(lf.bboxes[0].instance).toBe(u0);
    expect(lf.bboxes[1].instance).toBe(p0b);
    expect(lf.centroids[0].instance).toBe(u0);
    expect(lf.masks[0].instance).toBe(p0);
    expect((lf.masks[1] as UserSegmentationMask).fromPredicted).toBe(lf.masks[0] as PredictedSegmentationMask);
    expect(lf.labelImages[0].objects.get(1)?.instance).toBe(u0);
    expect(lf.rois[0].instance).toBe(u0);
    // A link to a prediction on another frame follows that frame's restore too.
    const u5 = labels.labeledFrames.find((f) => f.frameIdx === 5)!.instances[0];
    expect(u5.fromPredicted).toBe(p0 as PredictedInstance);
  });

  // A snapshot must not share storage with the live objects it copied: later
  // in-place edits (dragging a node, moving a box) would rewrite the history.
  it("in-place edits after a command don't reach into its undo snapshot", async () => {
    const { labels } = setup();
    const before = fingerprint(labels);
    await ctx.execute(DeleteAllPredictions);
    const lf = frame0(labels);
    lf.instances[0].points[0].xy = [99, 99];
    lf.bboxes[0].x1 = 42;
    (lf.masks[1] as UserSegmentationMask).scale[0] = 7;
    lf.labelImages[0].objects.get(1)!.category = "changed";
    ctx.undo();
    expect(fingerprint(labels)).toEqual(before);
  });

  // Undo of Delete Track used to restore only the current frame's tracks.
  it("Delete Track + undo restores the track on every frame, boxes included", async () => {
    const { labels } = setup();
    await ctx.execute(DeleteTrack, { trackIdx: 1 }); // t2
    for (const lf of labels.labeledFrames) {
      expect(lf.instances.some((i) => i.track?.name === "t2")).toBe(false);
    }
    expect(frame0(labels).bboxes[1].track).toBeNull();
    ctx.undo();
    expect(labels.labeledFrames.find((f) => f.frameIdx === 7)?.instances[0].track?.name).toBe("t2");
    expect(frame0(labels).bboxes[1].track?.name).toBe("t2");
    expect(frame0(labels).rois[0].track?.name).toBe("t2");
  });

  // A track still used by a box isn't "unused".
  it("Delete Unused Tracks keeps a track only an annotation uses", async () => {
    const { labels } = setup();
    for (const lf of labels.labeledFrames) {
      lf.instances = lf.instances.filter((i) => i.track?.name !== "t2");
    }
    await ctx.execute(DeleteUnusedTracks);
    expect(labels.tracks.map((t) => t.name)).toEqual(["t1", "t2"]);
  });

  // Turning off a negative mark used to drop the frame even when it had a centroid.
  it("un-marking a negative frame keeps its other annotations", async () => {
    const { labels, video } = setup();
    useAppStore.setState({ frameIdx: 3, labeledFrame: labels.find({ video, frameIdx: 3 })[0] });
    await ctx.execute(ToggleNegativeFrame);
    const lf = labels.find({ video, frameIdx: 3 })[0];
    expect(lf?.isNegative).toBe(false);
    expect(lf?.centroids).toHaveLength(1);
  });

  // The snapshot finds a frame's annotation lists generically; this fails if
  // sleap-io.js gives LabeledFrame a field that is neither a key nor a list.
  it("LabeledFrame's fields are all keys, the negative flag, or lists", () => {
    const { frame0: lf } = setup();
    for (const [key, value] of Object.entries(lf)) {
      if (["video", "frameIdx", "isNegative"].includes(key)) continue;
      expect(Array.isArray(value), key).toBe(true);
    }
  });
});
