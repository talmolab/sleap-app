/**
 * Labels ▸ Custom Instance Delete... — PyQt SLEAP's DeleteDialog
 * (dialogs/delete.py): instance type × frame scope × track, PyQt's wording.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import {
  customDeleteTargets,
  framesOptions,
  trackOptions,
  type CustomDeleteChoice,
} from "@/lib/customInstanceDelete";
import { CommandContext } from "@/commands/CommandContext";
import { DeleteInstancesCustom } from "@/commands/customDeleteCommands";
import { useAppStore } from "@/stores/appStore";

const sk = new Skeleton({ nodes: ["a"], name: "s" });
const user = (track: Track | null = null) => {
  const i = Instance.fromArray([[1, 1]], sk);
  if (track) i.track = track;
  return i;
};
const pred = (track: Track | null = null) => {
  const p = PredictedInstance.fromArray([[1, 1]], sk);
  if (track) p.track = track;
  return p;
};

/** Video v: frames 0..4, each one user + one prediction (prediction on track A).
 *  Video w: frame 0, one user + one prediction. */
function setup() {
  const v = new Video({ filename: "/v.mp4", openBackend: false });
  const w = new Video({ filename: "/w.mp4", openBackend: false });
  const A = new Track("A");
  const frames: LabeledFrame[] = [];
  for (let i = 0; i < 5; i++) {
    frames.push(new LabeledFrame({ video: v, frameIdx: i, instances: [user(), pred(A)] }));
  }
  frames.push(new LabeledFrame({ video: w, frameIdx: 0, instances: [user(), pred()] }));
  const labels = new Labels({ labeledFrames: frames, skeletons: [sk], videos: [v, w], tracks: [A] });
  return { labels, v, w, A };
}

const choice = (c: Partial<CustomDeleteChoice>): CustomDeleteChoice => ({
  instanceType: "predicted instances",
  frames: "current frame",
  track: "any",
  ...c,
});

describe("PyQt option lists", () => {
  // "all videos" needs >1 video; clip options need a seekbar selection.
  it("shows options under PyQt's conditions, in PyQt's words", () => {
    expect(framesOptions(1, false)).toEqual(["current frame", "current video"]);
    expect(framesOptions(2, true)).toEqual([
      "current frame",
      "current video",
      "all videos",
      "selected clip",
      "current video except for selected clip",
    ]);
    expect(trackOptions([])).toEqual([]);
    expect(trackOptions([new Track("A")])).toEqual([
      "any track identity (including none)",
      "no track identity set",
      "A",
    ]);
  });
});

describe("customDeleteTargets", () => {
  const scope = (v: Video, frameRange: [number, number] | null = null) => ({
    video: v,
    frameIdx: 2,
    frameRange,
  });

  // Instance type × frame scope, as PyQt's get_frames_instances.
  it("matches type and frame scope", () => {
    const { labels, v } = setup();
    expect(customDeleteTargets(labels, scope(v), choice({})).length).toBe(1);
    expect(
      customDeleteTargets(labels, scope(v), choice({ instanceType: "all instances" })).length
    ).toBe(2);
    expect(
      customDeleteTargets(labels, scope(v), choice({ frames: "current video" })).length
    ).toBe(5);
    expect(
      customDeleteTargets(labels, scope(v), choice({ instanceType: "user instances", frames: "all videos" })).length
    ).toBe(6);
  });

  // The seekbar clip is inclusive; "except" keeps to the current video.
  it("handles the selected clip and its complement in this video only", () => {
    const { labels, v } = setup();
    const inClip = customDeleteTargets(labels, scope(v, [1, 3]), choice({ frames: "selected clip" }));
    expect(inClip.map(([lf]) => lf.frameIdx)).toEqual([1, 2, 3]);
    const outside = customDeleteTargets(
      labels,
      scope(v, [1, 3]),
      choice({ frames: "current video except for selected clip" })
    );
    expect(outside.map(([lf]) => lf.frameIdx)).toEqual([0, 4]);
    expect(outside.every(([lf]) => lf.video === v)).toBe(true);
  });

  // Track filter: a named track, or "no track identity set".
  it("filters by track", () => {
    const { labels, v, A } = setup();
    const onA = customDeleteTargets(labels, scope(v), choice({ instanceType: "all instances", track: A }));
    expect(onA.every(([, i]) => i.track === A)).toBe(true);
    const none = customDeleteTargets(labels, scope(v), choice({ instanceType: "all instances", track: "none" }));
    expect(none.map(([, i]) => i instanceof PredictedInstance)).toEqual([false]);
  });
});

describe("DeleteInstancesCustom", () => {
  let ctx: CommandContext;
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
    const store = useAppStore.getState();
    store.setLabels(s.labels, "t.slp");
    store.setVideo(s.v);
    store.setFrameIdx(2);
    ctx = new CommandContext();
  });

  // Like PyQt's labels.clean(): emptied frames and now-unused tracks go; undo brings all back.
  it("deletes, cleans up, and undoes in one step", async () => {
    await ctx.execute(
      DeleteInstancesCustom,
      choice({ instanceType: "all instances", frames: "current video" }) as unknown as Record<string, unknown>
    );
    expect(s.labels.labeledFrames.filter((lf) => lf.video === s.v).length).toBe(0);
    expect(s.labels.tracks).toEqual([]);
    expect(s.labels.labeledFrames.length).toBe(1); // video w untouched

    expect(ctx.undo()).toBe(true);
    expect(s.labels.labeledFrames.length).toBe(6);
    expect(s.labels.tracks.map((t) => t.name)).toEqual(["A"]);
  });

  // A negative (background) frame stays even when its instances are deleted.
  it("keeps a negative frame", async () => {
    const lf = s.labels.labeledFrames[2]!;
    lf.isNegative = true;
    await ctx.execute(
      DeleteInstancesCustom,
      choice({ instanceType: "all instances" }) as unknown as Record<string, unknown>
    );
    expect(s.labels.labeledFrames.includes(lf)).toBe(true);
    expect(lf.instances.length).toBe(0);
  });
});
