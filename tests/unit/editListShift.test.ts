/**
 * sleap-io.js #274: on an MP4 cut with stream copy, the edit list hides a few
 * leading frames. io ≥ 0.5.18 numbers frames like ffmpeg (skipping them), so
 * labels made in earlier versions of this app sit N frames too late. The app
 * detects this on open, asks per video (Keep as is is the default), and — only
 * if asked to — shifts that video's old-numbered labels N frames earlier in one
 * undoable step. Each video's answer is recorded so it's never asked twice.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { ShiftVideoLabelsCommand } from "@/commands/editListCommands";
import { useAppStore } from "@/stores/appStore";
import {
  FRAME_INDEX_PROVENANCE_KEY,
  applyLabelShift,
  canHaveEditList,
  getVideoRecord,
  hasShiftableContent,
  hiddenLeadingFramesOf,
  planLabelShift,
  setVideoRecord,
  supportsHiddenFrameDetection,
} from "@/lib/editListShift";
import {
  KEEP_CHOICE,
  SHIFT_CHOICE,
  buildShiftPrompt,
  expectEditListCheck,
  runEditListCheck,
  type EditListCheckDeps,
  type HiddenFrameDetection,
} from "@/lib/editListCheck";
import {
  Instance,
  Labels,
  LabeledFrame,
  PredictedBoundingBox,
  PredictedInstance,
  Skeleton,
  SuggestionFrame,
  UserBoundingBox,
  Video,
  loadSlp,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";

const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
const user = (x: number) => Instance.fromArray([[x, x], [x + 1, x + 1]], skeleton);
const pred = (x: number) => {
  const p = PredictedInstance.fromArray([[x, x], [x + 1, x + 1]], skeleton);
  p.score = 0.9;
  return p;
};

/**
 * A video with a stand-in backend. `hidden` = what io ≥ 0.5.18 reports;
 * `"old-io"` = a 0.5.17 backend (no field at all); `null` = no backend (missing
 * or not opened yet).
 */
function makeVideo(filename: string, hidden: number | "old-io" | null): Video {
  const video = new Video({
    filename,
    backendMetadata: { shape: [100, 64, 64, 1] },
    openBackend: false,
  });
  video.backend = (
    hidden === null ? null : hidden === "old-io" ? {} : { hiddenLeadingFrames: hidden }
  ) as unknown as typeof video.backend;
  return video;
}

/**
 * Trimmed video (2 hidden frames) with: a user instance on frame 1 (lands
 * before frame 0 → removed), user + prediction on 5, prediction only on 3, a
 * SLEAP-made pair (user instance linked to the prediction on its frame) on 12,
 * a negative mark on 8, a user box on 10 (+ a predicted box), suggestions on 0
 * and 6; plus an untouched second video with a user instance on frame 5.
 */
function setup() {
  const video = makeVideo("/data/trimmed.mp4", 2);
  const other = makeVideo("/data/other.mp4", 0);
  const u1 = user(1);
  const u5 = user(5);
  const p5 = pred(50);
  const p3 = pred(30);
  const p12 = pred(12);
  const linked = user(12);
  linked.fromPredicted = p12;
  const box = new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10 });
  const predBox = new PredictedBoundingBox({ x1: 1, y1: 1, x2: 9, y2: 9, score: 0.8 });
  const otherUser = user(7);
  const labels = new Labels({
    videos: [video, other],
    skeletons: [skeleton],
    labeledFrames: [
      new LabeledFrame({ video, frameIdx: 1, instances: [u1] }),
      new LabeledFrame({ video: other, frameIdx: 5, instances: [otherUser] }),
      new LabeledFrame({ video, frameIdx: 3, instances: [p3] }),
      new LabeledFrame({ video, frameIdx: 5, instances: [p5, u5] }),
      new LabeledFrame({ video, frameIdx: 8, isNegative: true }),
      new LabeledFrame({ video, frameIdx: 10, bboxes: [box, predBox] }),
      new LabeledFrame({ video, frameIdx: 12, instances: [p12, linked] }),
    ],
    suggestions: [
      new SuggestionFrame({ video, frameIdx: 0 }),
      new SuggestionFrame({ video, frameIdx: 6, group: "g" }),
      new SuggestionFrame({ video: other, frameIdx: 4 }),
    ],
  });
  return { labels, video, other, u1, u5, p5, p3, p12, linked, box, predBox, otherUser };
}

const at = (labels: Labels, video: Video, frameIdx: number) =>
  labels.find({ video, frameIdx })[0] ?? null;
const frameOf = (labels: Labels, inst: Instance) =>
  labels.labeledFrames.find((lf) => lf.instances.includes(inst))?.frameIdx ?? null;

describe("edit-list detection helpers", () => {
  // Only io ≥ 0.5.18 backends carry the field; a 0.5.17 backend can't tell.
  it("knows which backends can report hidden frames", () => {
    expect(supportsHiddenFrameDetection(makeVideo("a.mp4", 2).backend)).toBe(true);
    expect(supportsHiddenFrameDetection(makeVideo("a.mp4", 0).backend)).toBe(true);
    expect(supportsHiddenFrameDetection(makeVideo("a.mp4", "old-io").backend)).toBe(false);
    expect(supportsHiddenFrameDetection(null)).toBe(false);
    expect(hiddenLeadingFramesOf(makeVideo("a.mp4", 2))).toBe(2);
    expect(hiddenLeadingFramesOf(makeVideo("a.mp4", "old-io"))).toBe(0);
  });

  // Only MP4/MOV containers have edit lists.
  it("only MP4/MOV videos can have an edit list", () => {
    expect(canHaveEditList(makeVideo("/x/a.MP4", 0))).toBe(true);
    expect(canHaveEditList(makeVideo("/x/a.mov", 0))).toBe(true);
    expect(canHaveEditList(makeVideo("/x/a.avi", 0))).toBe(false);
  });

  // Prediction-only videos have nothing to shift.
  it("knows when a video has old-numbered content", () => {
    const { labels, video } = setup();
    expect(hasShiftableContent(labels, video)).toBe(true);
    const predOnly = makeVideo("/data/pred.mp4", 3);
    labels.videos.push(predOnly);
    labels.labeledFrames.push(new LabeledFrame({ video: predOnly, frameIdx: 4, instances: [pred(1)] }));
    expect(hasShiftableContent(labels, predOnly)).toBe(false);
  });
});

describe("per-video records", () => {
  // Fix 2: answers are per video and survive a save, so one answered video is
  // never re-offered because another one is still open.
  it("records per video and survives save + reopen", async () => {
    const { labels, video, other } = setup();
    setVideoRecord(labels, video, "shifted");
    expect(getVideoRecord(labels, video)).toBe("shifted");
    expect(getVideoRecord(labels, other)).toBeNull();

    const reopened = await loadSlp(await saveSlpToBytes(labels), { openVideos: false });
    expect(reopened.provenance[FRAME_INDEX_PROVENANCE_KEY]).toEqual({ "/data/trimmed.mp4": "shifted" });
    expect(getVideoRecord(reopened, reopened.videos[0])).toBe("shifted");
    expect(getVideoRecord(reopened, reopened.videos[1])).toBeNull();
  });

  // A video located elsewhere still finds its record (original name, or an
  // unambiguous base name after it was moved and re-saved).
  it("matches a relocated video by original or base name", () => {
    const { labels, video } = setup();
    setVideoRecord(labels, video, "kept");
    video.filename = "/elsewhere/trimmed.mp4";
    expect(getVideoRecord(labels, video)).toBe("kept"); // unique base name
    (video.backendMetadata as Record<string, unknown>).sourceFilename = "/data/trimmed.mp4";
    expect(getVideoRecord(labels, video)).toBe("kept");
    // Two videos with the same base name: no guessing.
    delete (video.backendMetadata as Record<string, unknown>).sourceFilename;
    labels.videos.push(makeVideo("/other/trimmed.mp4", 2));
    expect(getVideoRecord(labels, video)).toBeNull();
  });
});

describe("applyLabelShift", () => {
  // Fix 4: each kind of label goes where its numbering says — user-made content
  // moves, predictions stay, and a SLEAP-made linked pair stays together (so
  // no link ever crosses frames).
  it("moves old-numbered labels; predictions and linked pairs stay", () => {
    const { labels, video, other, u1, u5, p5, p3, p12, linked, box, predBox, otherUser } = setup();
    applyLabelShift(labels, video, 2);

    expect(at(labels, video, 3)?.instances).toEqual([p3, u5]); // u5: 5 → 3
    expect(at(labels, video, 5)?.instances).toEqual([p5]);
    expect(at(labels, video, 6)?.isNegative).toBe(true); // 8 → 6
    expect(at(labels, video, 8)?.bboxes).toEqual([box]); // user box 10 → 8
    expect(at(labels, video, 8)?.isNegative).toBe(false);
    expect(at(labels, video, 10)?.bboxes).toEqual([predBox]);
    expect(frameOf(labels, u1)).toBeNull(); // frame 1 → −1: removed
    // The linked pair stays on 12 together; the link is untouched.
    expect(frameOf(labels, linked)).toBe(12);
    expect(frameOf(labels, p12)).toBe(12);
    expect(linked.fromPredicted).toBe(p12);
    // Suggestions: 6 → 4 (group kept), 0 removed; other video untouched.
    expect(labels.suggestions.map((s) => [s.video === video ? "v" : "o", s.frameIdx, s.group])).toEqual([
      ["v", 4, "g"],
      ["o", 4, "default"],
    ]);
    expect(at(labels, other, 5)?.instances).toEqual([otherUser]);
  });

  // An annotation linked to an instance follows it (a box made from a pose).
  it("moves an annotation with the instance it is linked to", () => {
    const video = makeVideo("/d/v.mp4", 1);
    const u = user(3);
    const p = pred(4);
    const userBoxOnPrediction = new UserBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 5 });
    (userBoxOnPrediction as unknown as { instance: Instance }).instance = p;
    const boxOnUser = new PredictedBoundingBox({ x1: 0, y1: 0, x2: 5, y2: 5, score: 1 });
    (boxOnUser as unknown as { instance: Instance }).instance = u;
    const labels = new Labels({
      videos: [video],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video, frameIdx: 4, instances: [p, u], bboxes: [userBoxOnPrediction, boxOnUser] }),
      ],
    });
    applyLabelShift(labels, video, 1);
    expect(at(labels, video, 3)?.bboxes).toEqual([boxOnUser]);
    expect(at(labels, video, 4)?.bboxes).toEqual([userBoxOnPrediction]);
  });

  // The prompt's numbers must match what the shift does.
  it("plans the shift: moved, removed and kept counts", () => {
    const { labels, video } = setup();
    expect(planLabelShift(labels, video, 2)).toEqual({
      movedFrames: 3, // user on 5, negative on 8, user box on 10
      droppedFrames: 1, // user on 1
      movedSuggestions: 1,
      droppedSuggestions: 1,
      framesWithPredictionsKept: 3, // 3, 5, 12
      linkedInstancesKept: 1,
    });
  });
});

describe("ShiftVideoLabelsCommand", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    ctx = new CommandContext();
  });

  const summary = (labels: Labels, video: Video) =>
    labels.labeledFrames
      .filter((lf) => lf.video === video)
      .map((lf) => `${lf.frameIdx}:${lf.instances.length}${lf.isNegative ? "N" : ""}:${lf.bboxes.length}`)
      .sort();

  // One command = one undo step; undo restores every frame number.
  // Fix 5: the record follows undo/redo — undoing the shift records "kept"
  // (so labels made after the undo can't be shifted on a later open), redo
  // records "shifted" again — and the project is marked changed.
  it("shifts in one undoable step and keeps the record in step with undo/redo", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setLabels(labels, "p.slp");
    const before = summary(labels, video);
    const beforeSugg = labels.suggestions.map((s) => s.frameIdx);

    await ctx.execute(ShiftVideoLabelsCommand, { video, by: 2 });
    const after = summary(labels, video);
    expect(after).not.toEqual(before);
    expect(getVideoRecord(labels, video)).toBe("shifted");
    expect(ctx.undoLabel).toBe("Shift labels 2 frames earlier on trimmed.mp4");
    expect(useAppStore.getState().hasChanges).toBe(true);

    expect(ctx.undo()).toBe(true);
    expect(summary(labels, video)).toEqual(before);
    expect(labels.suggestions.map((s) => s.frameIdx)).toEqual(beforeSugg);
    expect(getVideoRecord(labels, video)).toBe("kept");

    expect(ctx.redo()).toBe(true);
    expect(summary(labels, video)).toEqual(after);
    expect(getVideoRecord(labels, video)).toBe("shifted");
  });

  // Nothing to move → no undo step, no record.
  it("does nothing when there is nothing to move", async () => {
    const { labels, other } = setup();
    useAppStore.getState().setLabels(labels, "p.slp");
    labels.labeledFrames = labels.labeledFrames.filter((lf) => lf.video !== other);
    labels.suggestions = labels.suggestions.filter((s) => s.video !== other);
    labels.reindex();
    await ctx.execute(ShiftVideoLabelsCommand, { video: other, by: 2 });
    expect(ctx.canUndo).toBe(false);
    expect(getVideoRecord(labels, other)).toBeNull();
  });
});

describe("open-time check", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  /** Deps that answer every prompt with `answer` and apply shifts/keeps for real. */
  function deps(labels: Labels, answer: string | null, probe: HiddenFrameDetection | null = null) {
    const calls = { prompts: [] as string[], shifts: [] as Array<[Video, number]>, probes: [] as Video[] };
    const d: EditListCheckDeps = {
      probe: async (v) => {
        calls.probes.push(v);
        return probe;
      },
      choose: async (req) => {
        calls.prompts.push(req.title ?? "");
        return answer;
      },
      shift: async (v, by) => {
        calls.shifts.push([v, by]);
        applyLabelShift(labels, v, by);
        setVideoRecord(labels, v, "shifted");
      },
      keep: (l, v) => setVideoRecord(l, v, "kept"),
      currentLabels: () => labels,
    };
    return { d, calls };
  }

  /** An opened file: its videos are "from the file". */
  function opened() {
    const s = setup();
    expectEditListCheck(s.labels);
    return s;
  }

  // Shift chosen → the shift runs once and the video is recorded.
  it("shifts on request and records the video", async () => {
    const { labels, video } = opened();
    const { d, calls } = deps(labels, SHIFT_CHOICE);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual(["Frame numbers changed for “trimmed.mp4”"]);
    expect(calls.shifts).toEqual([[video, 2]]);
    expect(getVideoRecord(labels, video)).toBe("shifted");
  });

  // Fix 2 (reviewer's repro): A shifted while B is missing; reopening must not
  // offer A again (it would move A's labels twice: 10 → 8 → 6).
  it("never re-offers an answered video while another is still unknown", async () => {
    const a = makeVideo("/d/a.mp4", 2);
    const b = makeVideo("/d/b.mp4", null); // missing file
    const ua = user(1);
    const labels = new Labels({
      videos: [a, b],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: a, frameIdx: 10, instances: [ua] }),
        new LabeledFrame({ video: b, frameIdx: 5, instances: [user(2)] }),
      ],
    });
    expectEditListCheck(labels);
    const { d, calls } = deps(labels, SHIFT_CHOICE);
    await runEditListCheck(labels, d);
    expect(frameOf(labels, ua)).toBe(8);

    // Save + reopen: same file, a fresh session.
    const reopened = await loadSlp(await saveSlpToBytes(labels), { openVideos: false });
    reopened.videos[0].backend = a.backend;
    expectEditListCheck(reopened);
    const again = deps(reopened, SHIFT_CHOICE);
    await runEditListCheck(reopened, again.d);
    expect(again.calls.prompts).toEqual([]); // b is still missing; a is answered
    expect(reopened.labeledFrames.find((lf) => lf.video === reopened.videos[0])?.frameIdx).toBe(8);
    expect(calls.shifts.length).toBe(1);
  });

  // Fix 3: a missing video is asked about as soon as it's located (everything
  // on it is still from the file), and only it.
  it("asks about a missing video once it is located", async () => {
    const a = makeVideo("/d/a.mp4", 2);
    const b = makeVideo("/d/b.mp4", null);
    const labels = new Labels({
      videos: [a, b],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: a, frameIdx: 10, instances: [user(1)] }),
        new LabeledFrame({ video: b, frameIdx: 5, instances: [user(2)] }),
      ],
    });
    expectEditListCheck(labels);
    const { d, calls } = deps(labels, KEEP_CHOICE);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual(["Frame numbers changed for “a.mp4”"]);
    b.backend = { hiddenLeadingFrames: 3 } as unknown as typeof b.backend; // located
    await runEditListCheck(labels, d, { probe: false });
    expect(calls.prompts).toEqual(["Frame numbers changed for “a.mp4”", "Frame numbers changed for “b.mp4”"]);
    expect(getVideoRecord(labels, b)).toBe("kept");
  });

  // Fix 3: closing the message keeps the labels and records it, so labels made
  // later in the new numbering can never be shifted by a later prompt.
  it("treats closing the message as Keep and doesn't ask again", async () => {
    const { labels, video } = opened();
    const { d, calls } = deps(labels, null);
    await runEditListCheck(labels, d);
    expect(calls.shifts).toEqual([]);
    expect(getVideoRecord(labels, video)).toBe("kept");
    await runEditListCheck(labels, d);
    expect(calls.prompts.length).toBe(1);
  });

  // Videos added this session (or in a new project) are numbered like ffmpeg:
  // recorded without a question, never shifted.
  it("records videos that didn't come from the file without asking", async () => {
    const { labels, video } = setup(); // not opened: a new project / import
    const { d, calls } = deps(labels, SHIFT_CHOICE);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual([]);
    expect(getVideoRecord(labels, video)).toBe("ffmpeg");
  });

  // Fix 1: with io 0.5.17 nothing can be detected, so nothing is asked AND
  // nothing is recorded — the check still works after the io bump.
  it("records nothing when io can't detect hidden frames (0.5.17)", async () => {
    const { labels, video } = setup();
    video.backend = {} as unknown as typeof video.backend; // 0.5.17: no field
    expectEditListCheck(labels);
    const { d, calls } = deps(labels, SHIFT_CHOICE);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual([]);
    expect(labels.provenance[FRAME_INDEX_PROVENANCE_KEY]).toBeUndefined();

    const fresh = setup(); // a new project on 0.5.17 isn't stamped either
    fresh.video.backend = {} as unknown as typeof fresh.video.backend;
    await runEditListCheck(fresh.labels, deps(fresh.labels, SHIFT_CHOICE).d);
    expect(fresh.labels.provenance[FRAME_INDEX_PROVENANCE_KEY]).toBeUndefined();
  });

  // Fix 7 / memory: a video desktop hasn't opened yet is probed with a
  // temporary backend (never assigned), once.
  it("probes a deferred video without keeping a backend", async () => {
    const { labels, video } = opened();
    video.backend = null;
    const { d, calls } = deps(labels, KEEP_CHOICE, { supported: true, hidden: 2 });
    await runEditListCheck(labels, d);
    expect(calls.probes).toEqual([video]);
    expect(video.backend).toBeNull();
    expect(calls.prompts.length).toBe(1);
    expect(getVideoRecord(labels, video)).toBe("kept");
  });

  // A file that can't be opened stays unanswered (asked once it can be).
  it("leaves an unopenable video unanswered", async () => {
    const { labels, video } = opened();
    video.backend = null;
    const { d, calls } = deps(labels, SHIFT_CHOICE, null);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual([]);
    expect(getVideoRecord(labels, video)).toBeNull();
  });

  // Opening another project mid-check must not touch the new one.
  it("stops if the project is replaced", async () => {
    const { labels } = opened();
    const { d, calls } = deps(labels, SHIFT_CHOICE);
    d.currentLabels = () => null;
    await runEditListCheck(labels, d);
    expect(calls.prompts).toEqual([]);
  });

  // Fix 6: "Keep as is" is the default; there is no third "later" answer.
  // The prompt says what moves, what is removed and what stays.
  it("describes the shift with counts and defaults to Keep", () => {
    const { labels, video } = setup();
    const req = buildShiftPrompt({ video, hidden: 2, plan: planLabelShift(labels, video, 2) });
    expect(req.title).toBe("Frame numbers changed for “trimmed.mp4”");
    expect(req.message).toContain("starts with 2 hidden frames");
    expect(req.message).toContain("• 3 labeled frames: instances drawn or accepted in this app");
    expect(req.message).toContain("• 1 suggestion\n");
    expect(req.message).toContain("• Removed: 1 labeled frame and 1 suggestion on the hidden frames");
    expect(req.message).toContain(
      "Stays where it is: predictions (made by SLEAP or sleap-nn, already right), and 1 instance linked to a prediction on its frame (made in SLEAP)."
    );
    expect(req.message).toContain("Closing this message keeps the labels as they are");
    expect(req.options).toEqual([
      { key: SHIFT_CHOICE, label: "Shift 2 frames earlier" },
      { key: KEEP_CHOICE, label: "Keep as is", primary: true },
    ]);
    expect(req.hideCancel).toBe(true);
  });
});
