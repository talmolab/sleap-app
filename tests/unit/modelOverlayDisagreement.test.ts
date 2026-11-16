/**
 * Compare Model Predictions, part 2: matching poses across models, the
 * disagreement highlight, and Accept (a model's pose → user instance).
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { Labels, LabeledFrame, PredictedInstance, Instance, Skeleton, Track } from "@talmolab/sleap-io.js";
import {
  hungarian,
  groupAcrossModels,
  findDisagreements,
  matchPoses,
  modelsShareTracks,
} from "@/lib/modelOverlay/matching";
import { findDisagreementFrame, frameDisagreements } from "@/hooks/useModelOverlayFrame";
import { hitTestModelOverlay } from "@/canvas/modelOverlayRenderer";
import { AcceptModelPose } from "@/commands/modelOverlayCommands";
import { modelClickRoute, acceptModelPose } from "@/lib/modelOverlay/canvasActions";
import { useConfirmStore } from "@/stores/confirmStore";
import { parseThreshold } from "@/components/video/ModelOverlayLegend";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { NODES, makePred, makeUser, makeVideo, poseAt } from "./modelOverlayTestData";

function pose(xy: [number, number][], trackName: string | null = null): OverlayPose {
  return { xy: Float64Array.from(xy.flat()), score: 0.9, trackName };
}

/** Shift every node of a pose by (dx, dy); `onlyNode` shifts just that one. */
function shifted(xy: [number, number][], dx: number, dy: number, onlyNode?: number): [number, number][] {
  return xy.map(([x, y], i) => (onlyNode === undefined || onlyNode === i ? [x + dx, y + dy] : [x, y]));
}

describe("hungarian", () => {
  // The classic check: the greedy pick (row 0 → col 0) isn't the cheapest overall.
  it("finds the minimum-cost assignment", () => {
    expect(hungarian([
      [1, 2],
      [1, 10],
    ])).toEqual([1, 0]);
  });

  // More animals in one model than another: extra rows stay unassigned.
  it("leaves extra rows unassigned in a tall matrix", () => {
    const a = hungarian([[5], [1], [9]]);
    expect(a).toEqual([-1, 0, -1]);
  });
});

describe("matchPoses", () => {
  // Two animals far apart must never be paired just because each model found one.
  it("drops pairs beyond the same-animal gate", () => {
    expect(matchPoses([Float64Array.from(poseAt(0, 0).flat())], [Float64Array.from(poseAt(500, 500).flat())])).toEqual([-1]);
  });
});

describe("groupAcrossModels", () => {
  // Untracked multi-animal files: poses group by position, whatever order each model lists them in.
  it("groups by position with the Hungarian method", () => {
    const a = { poses: [pose(poseAt(100, 100)), pose(poseAt(300, 300))] };
    const b = { poses: [pose(poseAt(302, 299)), pose(poseAt(101, 98))] };
    const groups = groupAcrossModels([a, b], false);
    expect(groups).toEqual([
      [{ layer: 0, pose: 0 }, { layer: 1, pose: 1 }],
      [{ layer: 0, pose: 1 }, { layer: 1, pose: 0 }],
    ]);
  });

  // The user decided: when every file shares tracks, group by track, not by position.
  it("groups by track name when asked", () => {
    const a = { poses: [pose(poseAt(100, 100), "t1"), pose(poseAt(300, 300), "t2")] };
    const b = { poses: [pose(poseAt(300, 300), "t1")] };
    expect(groupAcrossModels([a, b], true)).toEqual([
      [{ layer: 0, pose: 0 }, { layer: 1, pose: 0 }],
      [{ layer: 0, pose: 1 }],
    ]);
  });

  // Review: a model that gives two poses the same track must not put both in one group.
  it("keeps one pose per model per track group", () => {
    const a = { poses: [pose(poseAt(100, 100), "t1")] };
    const b = { poses: [pose(poseAt(400, 400), "t1"), pose(poseAt(101, 99), "t1")] };
    expect(groupAcrossModels([a, b], true)).toEqual([
      [{ layer: 0, pose: 0 }, { layer: 1, pose: 1 }],
      [{ layer: 1, pose: 0 }],
    ]);
  });

  // Tracks only count as shared when every model has the same set of names.
  it("detects shared tracks", () => {
    expect(modelsShareTracks([new Set(["a", "b"]), new Set(["b", "a"])])).toBe(true);
    expect(modelsShareTracks([new Set(["a"]), new Set()])).toBe(false);
  });
});

describe("findDisagreements", () => {
  // One node 30 px apart between two models → spread 15 px (RMS from their mean) → flagged at 10.
  it("flags only nodes whose spread exceeds the threshold", () => {
    const base = poseAt(100, 100);
    const layers = [{ poses: [pose(base)] }, { poses: [pose(shifted(base, 30, 0, 2))] }];
    const d = findDisagreements(layers, groupAcrossModels(layers, false), 10);
    expect(d.length).toBe(1);
    expect(d[0].node).toBe(2);
    expect(d[0].spread).toBeCloseTo(15);
    expect(d[0].x).toBeCloseTo(115);
    expect(findDisagreements(layers, groupAcrossModels(layers, false), 20)).toEqual([]);
  });

  // A node only one model placed has nothing to disagree with.
  it("ignores nodes placed by a single model", () => {
    const a = poseAt(100, 100);
    const b = shifted(a, 0, 0);
    b[1] = [NaN, NaN];
    const c = [...a] as [number, number][];
    c[1] = [400, 400];
    const layers = [{ poses: [pose(c)] }, { poses: [pose(b)] }];
    expect(findDisagreements(layers, groupAcrossModels(layers, false), 1)).toEqual([]);
  });
});

function model(id: string, frames: Record<number, OverlayPose[]>, video = makeVideo()): OverlayModel {
  return {
    id,
    name: id,
    source: id,
    color: MODEL_COLORS[0],
    visible: true,
    video,
    frames: new Map(Object.entries(frames).map(([f, p]) => [Number(f), p])),
    trackNames: new Set(),
  };
}

describe("findDisagreementFrame", () => {
  // The legend's ◀ ▶ jump to the next frame where the models disagree, skipping agreeing ones.
  it("finds the next and previous disagreeing frame", () => {
    const video = makeVideo();
    const base = poseAt(50, 50);
    const a = model("a", { 1: [pose(base)], 4: [pose(base)], 9: [pose(base)] }, video);
    const b = model("b", { 1: [pose(shifted(base, 40, 0, 0))], 4: [pose(base)], 9: [pose(shifted(base, 40, 0, 0))] }, video);
    expect(findDisagreementFrame([a, b], video, 10, 1, 1)).toBe(9);
    expect(findDisagreementFrame([a, b], video, 10, 9, -1)).toBe(1);
    expect(findDisagreementFrame([a, b], video, 10, 9, 1)).toBeNull();
    expect(frameDisagreements([], false, 10)).toEqual([]);
  });
});

describe("hitTestModelOverlay", () => {
  // Clicking near a model's node picks that model's pose (nearest wins).
  it("returns the nearest model node within the threshold", () => {
    const layers = [
      { modelId: "a", color: MODEL_COLORS[0], poses: [pose(poseAt(100, 100))] },
      { modelId: "b", color: MODEL_COLORS[1], poses: [pose(poseAt(104, 100))] },
    ];
    const id = (x: number, y: number): [number, number] => [x, y];
    expect(hitTestModelOverlay(layers, 103, 100, 5, id)).toEqual({ layer: 1, pose: 0, node: 1 });
    expect(hitTestModelOverlay(layers, 300, 300, 5, id)).toBeNull();
  });
});

describe("AcceptModelPose", () => {
  let ctx: CommandContext;
  let skeleton: Skeleton;
  let labels: Labels;
  let lf: LabeledFrame;
  let trackA: Track;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useModelOverlayStore.getState().clear();
    ctx = new CommandContext();
    skeleton = new Skeleton({ nodes: NODES, name: "s" });
    const video = makeVideo();
    trackA = new Track("mouse A");
    lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(makePred(skeleton, poseAt(100, 100), { track: trackA }));
    lf.instances.push(makePred(skeleton, poseAt(300, 300)));
    labels = new Labels({ videos: [video], skeletons: [skeleton], tracks: [trackA], labeledFrames: [lf] });
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setFrameIdx(0);
  });

  // The user decided: Accept replaces the project's prediction it matches, keeping its track.
  it("replaces the matching prediction and keeps its track", async () => {
    const poses = [pose(poseAt(298, 305)), pose(poseAt(103, 99))];
    await ctx.execute(AcceptModelPose, { poses, poseIdx: 1, modelName: "m" });
    expect(lf.instances.length).toBe(2);
    const inst = lf.instances[0];
    expect(inst instanceof PredictedInstance).toBe(false);
    expect(inst.track).toBe(trackA);
    expect(inst.points[1].xy).toEqual([103, 99]);
    expect(inst.points[1].complete).toBe(false);
    expect(lf.instances[1] instanceof PredictedInstance).toBe(true);
  });

  // No prediction nearby: the pose is added as a new instance, nothing removed.
  it("adds a new instance when no prediction matches", async () => {
    await ctx.execute(AcceptModelPose, { poses: [pose(poseAt(600, 50))], poseIdx: 0, modelName: "m" });
    expect(lf.instances.length).toBe(3);
    expect(lf.instances[2] instanceof Instance && !(lf.instances[2] instanceof PredictedInstance)).toBe(true);
    expect(lf.instances[2].track).toBeNull();
  });

  // Accept is one undo step that puts the prediction back.
  it("undoes in one step", async () => {
    await ctx.execute(AcceptModelPose, { poses: [pose(poseAt(100, 100))], poseIdx: 0, modelName: "m" });
    expect(lf.instances.some((i) => !(i instanceof PredictedInstance))).toBe(true);
    ctx.undo();
    const frame = labels.find({ video: labels.videos[0], frameIdx: 0 })[0];
    expect(frame.instances.length).toBe(2);
    expect(frame.instances.every((i) => i instanceof PredictedInstance)).toBe(true);
  });

  // Review: on an animal you already labeled (no prediction to replace), Accept
  // must not silently stack a duplicate — without the user's OK nothing changes.
  it("changes nothing on a labeled animal unless told to replace", async () => {
    const user = makeUser(skeleton, poseAt(100, 100), trackA);
    lf.instances.splice(0, 1, user);
    await ctx.execute(AcceptModelPose, { poses: [pose(poseAt(102, 101))], poseIdx: 0, modelName: "m" });
    expect(lf.instances.length).toBe(2);
    expect(lf.instances[0]).toBe(user);
  });

  // The canvas action asks before replacing a user instance; cancelling changes nothing, confirming replaces.
  it("asks before replacing a user instance from the canvas", async () => {
    const user = makeUser(skeleton, poseAt(100, 100), trackA);
    lf.instances.splice(0, 1, user);
    useModelOverlayStore.getState().addModels(labels, [
      { name: "m", source: "/m.slp", video: labels.videos[0], frames: new Map([[0, [pose(poseAt(103, 100))]]]) },
    ]);
    const id = useModelOverlayStore.getState().models[0].id;

    let done = acceptModelPose(id, 0);
    await Promise.resolve();
    expect(useConfirmStore.getState().request?.confirmLabel).toBe("Replace");
    useConfirmStore.getState().respond(false);
    await done;
    expect(lf.instances[0]).toBe(user);

    done = acceptModelPose(id, 0);
    await Promise.resolve();
    useConfirmStore.getState().respond(true);
    await done;
    expect(lf.instances[0]).not.toBe(user);
    expect(lf.instances[0].track).toBe(trackA);
  });

  // After the user confirms, the labeled animal's instance is replaced, keeping its track.
  it("replaces the matching user instance when confirmed", async () => {
    lf.instances.splice(0, 1, makeUser(skeleton, poseAt(100, 100), trackA));
    await ctx.execute(AcceptModelPose, { poses: [pose(poseAt(102, 101))], poseIdx: 0, modelName: "m", replaceUser: true });
    expect(lf.instances.length).toBe(2);
    expect(lf.instances[0].track).toBe(trackA);
    expect(lf.instances[0].points[1].xy).toEqual([102, 101]);
  });
});

describe("click routing", () => {
  const none = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
  const alt = { ...none, altKey: true };

  // User decision: the project's predictions keep plain clicks/double-clicks while models are shown.
  it("gives plain clicks to the project, predictions included", () => {
    expect(modelClickRoute(none, true, "predicted")).toBe("project");
    expect(modelClickRoute(none, true, null)).toBe("project");
  });

  // Alt+click is the explicit model gesture, over predictions or empty space.
  it("gives Alt+click on a model node to the model", () => {
    expect(modelClickRoute(alt, true, "predicted")).toBe("model");
    expect(modelClickRoute(alt, true, null)).toBe("model");
  });

  // Alt+drag on a user instance moves it (existing gesture), so users keep Alt too.
  it("keeps Alt+click on a user instance for the user instance", () => {
    expect(modelClickRoute(alt, true, "user")).toBe("project");
    expect(modelClickRoute({ ...alt, shiftKey: true }, true, "predicted")).toBe("project");
    expect(modelClickRoute(alt, false, null)).toBe("project");
  });
});

describe("threshold input", () => {
  // Review: clearing the box used to set 0 px and ring every node.
  it("ignores empty, invalid and negative input", () => {
    expect(parseThreshold("")).toBeNull();
    expect(parseThreshold("abc")).toBeNull();
    expect(parseThreshold("-3")).toBeNull();
    expect(parseThreshold("12.5")).toBe(12.5);
    expect(parseThreshold("0")).toBe(0);
  });
});
