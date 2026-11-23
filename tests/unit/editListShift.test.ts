/**
 * sleap-io.js #274: on an MP4 cut with stream copy, the edit list hides a few
 * leading frames. io now numbers frames like ffmpeg (skipping them), so labels
 * made in earlier versions of this app sit N frames too late. The app detects
 * this on open, asks, and (only if asked to) shifts the video's user-made labels
 * N frames earlier in one undoable step. Predictions never move: they come from
 * SLEAP / sleap-nn, which always numbered frames like ffmpeg.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { ShiftVideoLabelsCommand } from "@/commands/editListCommands";
import { useAppStore } from "@/stores/appStore";
import {
  FRAME_INDEX_MARKER,
  applyLabelShift,
  canHaveEditList,
  findEditListCandidates,
  hasFrameIndexMarker,
  hasShiftableContent,
  hiddenLeadingFramesOf,
  planLabelShift,
} from "@/lib/editListShift";
import {
  KEEP_CHOICE,
  SHIFT_CHOICE,
  buildShiftPrompt,
  expectEditListCheck,
  runEditListCheck,
  type EditListCheckDeps,
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
} from "@talmolab/sleap-io.js";

const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
const user = (x: number) => Instance.fromArray([[x, x], [x + 1, x + 1]], skeleton);
const pred = (x: number) => {
  const p = PredictedInstance.fromArray([[x, x], [x + 1, x + 1]], skeleton);
  p.score = 0.9;
  return p;
};

function makeVideo(filename: string, hidden: number | undefined): Video {
  const video = new Video({
    filename,
    backendMetadata: { shape: [100, 64, 64, 1] },
    openBackend: false,
  });
  // Stand-in backend: only the field the check reads.
  video.backend = (hidden === undefined ? {} : { hiddenLeadingFrames: hidden }) as unknown as typeof video.backend;
  return video;
}

/**
 * Trimmed video (2 hidden frames) with: a user instance on frame 1 (a hidden
 * frame once shifted → removed), user + prediction on 5, prediction only on 3,
 * a negative mark on 8, a user box on 10, suggestions on 0 and 6; plus an
 * untouched second video with a user instance on frame 5.
 */
function setup() {
  const video = makeVideo("/data/trimmed.mp4", 2);
  const other = makeVideo("/data/other.mp4", 0);
  const u1 = user(1);
  const u5 = user(5);
  const p5 = pred(50);
  const p3 = pred(30);
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
    ],
    suggestions: [
      new SuggestionFrame({ video, frameIdx: 0 }),
      new SuggestionFrame({ video, frameIdx: 6, group: "g" }),
      new SuggestionFrame({ video: other, frameIdx: 4 }),
    ],
  });
  return { labels, video, other, u1, u5, p5, p3, box, predBox, otherUser };
}

const at = (labels: Labels, video: Video, frameIdx: number) =>
  labels.find({ video, frameIdx })[0] ?? null;

describe("edit-list detection helpers", () => {
  // The field comes from sleap-io.js ≥ 0.5.18; older io reports nothing → 0.
  it("reads hiddenLeadingFrames from the backend, 0 when absent", () => {
    expect(hiddenLeadingFramesOf(makeVideo("a.mp4", 2))).toBe(2);
    expect(hiddenLeadingFramesOf(makeVideo("a.mp4", undefined))).toBe(0);
    const noBackend = makeVideo("a.mp4", 1);
    noBackend.backend = null;
    expect(hiddenLeadingFramesOf(noBackend)).toBe(0);
  });

  // Only MP4/MOV containers have edit lists.
  it("only MP4/MOV videos can have an edit list", () => {
    expect(canHaveEditList(makeVideo("/x/a.MP4", 0))).toBe(true);
    expect(canHaveEditList(makeVideo("/x/a.mov", 0))).toBe(true);
    expect(canHaveEditList(makeVideo("/x/a.avi", 0))).toBe(false);
  });

  // The question only makes sense for a video with hidden frames AND something
  // the user made on it; prediction-only videos have nothing to move.
  it("finds videos with hidden frames and user-made labels", () => {
    const { labels, video, other } = setup();
    const { candidates, uncheckedVideos } = findEditListCandidates(labels);
    expect(candidates.map((c) => c.video)).toEqual([video]);
    expect(candidates[0].hidden).toBe(2);
    expect(uncheckedVideos).toBe(0);
    expect(hasShiftableContent(labels, other)).toBe(true);

    // A video whose only frames are predictions is not offered.
    const predOnly = makeVideo("/data/pred.mp4", 3);
    labels.videos.push(predOnly);
    labels.labeledFrames.push(new LabeledFrame({ video: predOnly, frameIdx: 4, instances: [pred(1)] }));
    labels.reindex();
    expect(findEditListCandidates(labels).candidates.map((c) => c.video)).toEqual([video]);

    // A missing file with labels can't be checked yet.
    const missing = makeVideo("/data/missing.mp4", 0);
    missing.backend = null;
    labels.videos.push(missing);
    labels.labeledFrames.push(new LabeledFrame({ video: missing, frameIdx: 2, instances: [user(2)] }));
    labels.reindex();
    expect(findEditListCandidates(labels).uncheckedVideos).toBe(1);
  });

  // The dialog's numbers must match what the shift will do.
  it("plans the shift: moved, removed and kept counts", () => {
    const { labels, video } = setup();
    expect(planLabelShift(labels, video, 2)).toEqual({
      movedFrames: 3, // user on 5, negative on 8, user box on 10
      droppedFrames: 1, // user on 1 → would be −1
      movedSuggestions: 1, // 6 → 4
      droppedSuggestions: 1, // 0 → −2
      framesWithPredictionsKept: 3, // 3, 5, 10
    });
  });
});

describe("applyLabelShift", () => {
  // User-made content moves N earlier; predictions stay; other videos untouched.
  it("moves user labels, negative marks and suggestions; predictions stay", () => {
    const { labels, video, other, u1, u5, p5, p3, box, predBox, otherUser } = setup();
    applyLabelShift(labels, video, 2);

    // Frame 5's user instance → 3, joining the prediction already there.
    expect(at(labels, video, 3)?.instances).toEqual([p3, u5]);
    // Frame 5 keeps only its prediction.
    expect(at(labels, video, 5)?.instances).toEqual([p5]);
    // Negative mark 8 → 6.
    expect(at(labels, video, 6)?.isNegative).toBe(true);
    // User box 10 → 8 (frame 8 is no longer negative); predicted box stays on 10.
    expect(at(labels, video, 8)?.isNegative).toBe(false);
    expect(at(labels, video, 8)?.bboxes).toEqual([box]);
    expect(at(labels, video, 10)?.bboxes).toEqual([predBox]);
    // The user instance on hidden frame 1 is removed.
    expect(labels.labeledFrames.some((lf) => lf.instances.includes(u1))).toBe(false);
    // Suggestions: 6 → 4 (group kept), 0 removed; other video's untouched.
    const sugg = labels.suggestions.map((s) => [s.video === video ? "v" : "o", s.frameIdx, s.group]);
    expect(sugg).toEqual([
      ["v", 4, "g"],
      ["o", 4, "default"],
    ]);
    // Other video untouched.
    expect(at(labels, other, 5)?.instances).toEqual([otherUser]);
  });

  // Nothing to shift → nothing changes.
  it("is a no-op for by <= 0", () => {
    const { labels, video } = setup();
    const before = labels.labeledFrames.map((lf) => [lf.frameIdx, lf.instances.length]);
    applyLabelShift(labels, video, 0);
    expect(labels.labeledFrames.map((lf) => [lf.frameIdx, lf.instances.length])).toEqual(before);
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
  const suggestions = (labels: Labels) => labels.suggestions.map((s) => s.frameIdx);

  // One command = one undo step: undo restores every frame number, redo re-applies.
  it("shifts in one undoable step and round-trips through undo/redo", async () => {
    const { labels, video } = setup();
    useAppStore.getState().setLabels(labels, "p.slp");
    const before = summary(labels, video);
    const beforeSugg = suggestions(labels);

    await ctx.execute(ShiftVideoLabelsCommand, { video, by: 2 });
    const after = summary(labels, video);
    expect(after).not.toEqual(before);
    expect(at(labels, video, 3)?.instances.length).toBe(2);
    expect(ctx.undoLabel).toBe("Shift labels 2 frames earlier on trimmed.mp4");
    expect(useAppStore.getState().hasChanges).toBe(true);

    expect(ctx.undo()).toBe(true);
    expect(summary(labels, video)).toEqual(before);
    expect(suggestions(labels)).toEqual(beforeSugg);
    expect(at(labels, video, 3)?.instances.length).toBe(1);

    expect(ctx.redo()).toBe(true);
    expect(summary(labels, video)).toEqual(after);
  });

  // A video with nothing user-made leaves no undo step behind.
  it("does nothing (no undo step) when there is nothing to move", async () => {
    const { labels, other } = setup();
    useAppStore.getState().setLabels(labels, "p.slp");
    labels.labeledFrames = labels.labeledFrames.filter((lf) => lf.video !== other);
    labels.suggestions = labels.suggestions.filter((s) => s.video !== other);
    labels.reindex();
    await ctx.execute(ShiftVideoLabelsCommand, { video: other, by: 2 });
    expect(ctx.canUndo).toBe(false);
  });
});

describe("open-time check", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  function deps(answer: string | null, labels: Labels) {
    const calls = { prompts: 0, shifts: [] as Array<[Video, number]>, opened: [] as Video[] };
    const d: EditListCheckDeps = {
      ensureBackend: async (v) => {
        calls.opened.push(v);
        return false;
      },
      choose: async () => {
        calls.prompts += 1;
        return answer;
      },
      shift: async (v, by) => {
        calls.shifts.push([v, by]);
      },
      currentLabels: () => labels,
    };
    return { d, calls };
  }

  // Shift chosen → the shift runs, and the file is marked so it isn't asked again.
  it("shifts on request and stamps the marker", async () => {
    const { labels, video } = setup();
    const { d, calls } = deps(SHIFT_CHOICE, labels);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toBe(1);
    expect(calls.shifts).toEqual([[video, 2]]);
    expect(hasFrameIndexMarker(labels)).toBe(true);
  });

  // Keep → nothing moves (never silent), marker stamped.
  it("keeps labels on request and stamps the marker", async () => {
    const { labels } = setup();
    const { d, calls } = deps(KEEP_CHOICE, labels);
    await runEditListCheck(labels, d);
    expect(calls.shifts).toEqual([]);
    expect(hasFrameIndexMarker(labels)).toBe(true);
  });

  // "Ask me later" → nothing moves and the question comes back next time.
  it("asks again later when dismissed", async () => {
    const { labels } = setup();
    const { d, calls } = deps(null, labels);
    await runEditListCheck(labels, d);
    expect(calls.shifts).toEqual([]);
    expect(hasFrameIndexMarker(labels)).toBe(false);
  });

  // A file saved by this version is already numbered like ffmpeg: no question.
  it("skips files that carry the marker", async () => {
    const { labels } = setup();
    labels.provenance = { [FRAME_INDEX_MARKER.key]: FRAME_INDEX_MARKER.value };
    const { d, calls } = deps(SHIFT_CHOICE, labels);
    await runEditListCheck(labels, d);
    expect(calls.prompts).toBe(0);
  });

  // Desktop defers decoders until first view: the check opens MP4/MOV videos
  // with user labels so their edit lists can be read; an unopenable one keeps
  // the file unstamped.
  it("opens deferred videos that have labels, and waits on missing ones", async () => {
    const { labels, video } = setup();
    video.backend = null;
    const { d, calls } = deps(SHIFT_CHOICE, labels);
    await runEditListCheck(labels, d);
    expect(calls.opened).toEqual([video]);
    expect(calls.prompts).toBe(0); // still no backend → can't tell yet
    expect(hasFrameIndexMarker(labels)).toBe(false);
  });

  // Opening another project mid-check must not touch the new one.
  it("stops if the project is replaced", async () => {
    const { labels } = setup();
    const { d, calls } = deps(SHIFT_CHOICE, labels);
    d.currentLabels = () => null;
    await runEditListCheck(labels, d);
    expect(calls.prompts).toBe(0);
    expect(hasFrameIndexMarker(labels)).toBe(false);
  });

  // New projects and imports are numbered by this version: stamped on install,
  // unless an open is about to run the check.
  it("stamps projects installed without a pending check", () => {
    const fresh = new Labels({ videos: [], skeletons: [skeleton] });
    useAppStore.getState().setLabels(fresh, "new.slp");
    expect(hasFrameIndexMarker(fresh)).toBe(true);

    const { labels } = setup();
    expectEditListCheck(labels);
    useAppStore.getState().setLabels(labels, "old.slp");
    expect(hasFrameIndexMarker(labels)).toBe(false);
  });

  // The prompt says what will move and what will be removed, in plain words.
  it("describes the shift with counts", () => {
    const { labels, video } = setup();
    const req = buildShiftPrompt({ video, hidden: 2, plan: planLabelShift(labels, video, 2) });
    expect(req.title).toBe("Frame numbers changed for “trimmed.mp4”");
    expect(req.message).toContain("starts with 2 hidden frames");
    expect(req.message).toContain("• 3 labeled frames");
    expect(req.message).toContain("• 1 suggestion\n");
    expect(req.message).toContain("1 labeled frame and 1 suggestion on the hidden frames will be removed");
    expect(req.message).toContain("Predictions stay where they are");
    expect(req.options.map((o) => o.key)).toEqual([KEEP_CHOICE, SHIFT_CHOICE]);
    expect(req.options[1].label).toBe("Shift 2 frames earlier");
    expect(req.cancelLabel).toBe("Ask me later");
  });
});
