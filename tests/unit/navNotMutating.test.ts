/**
 * Navigation commands aren't edits (#468).
 *
 * Commands whose topics are only Frame/View just move the playhead. They must
 * not push an undo step, clear redo, or flag the incremental autosave for a
 * full rewrite — but Frame listeners must still hear about the move.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import * as nav from "@/commands/navCommands";
import { UpdateTopic } from "@/types";
import type { Command } from "@/commands/types";
import {
  Labels,
  LabeledFrame,
  Instance,
  Video,
  Skeleton,
  SuggestionFrame,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

function undoDepth(ctx: CommandContext): number {
  return (ctx as unknown as { undoStack: unknown[] }).undoStack.length;
}
function redoDepth(ctx: CommandContext): number {
  return (ctx as unknown as { redoStack: unknown[] }).redoStack.length;
}

/** User-labeled frames at 0 and 5, a suggestion at 8, marked frame at 3. */
function setup() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  sk.addEdge(sk.nodes[0], sk.nodes[1]);
  const video = new Video({
    filename: "/v/clip.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({
    labeledFrames: [0, 5].map(
      (f) =>
        new LabeledFrame({
          video,
          frameIdx: f,
          instances: [Instance.fromArray([[10, 10], [11, 11]], sk)],
        })
    ),
    skeletons: [sk],
    videos: [video],
  });
  labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 8 }));
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(0);
  store.setMarkedFrame({ video, frameIdx: 3 });
  return { labels, video };
}

/** A real edit: moves the first point of the instance on the current frame. */
const NudgePoint: Command = {
  name: "NudgePoint",
  topics: [UpdateTopic.Instance],
  execute(ctx) {
    const lf = ctx.state.labeledFrame;
    if (!lf) return;
    const inst = lf.instances[0];
    inst.points[0].xy = [inst.points[0].xy[0] + 100, inst.points[0].xy[1]];
  },
};

function firstX(labels: Labels, frameIdx: number): number {
  const lf = labels.labeledFrames.find((f) => f.frameIdx === frameIdx)!;
  return lf.instances[0].points[0].xy[0];
}

/** Every command in navCommands.ts whose topics are only Frame/View. */
const NAV_COMMANDS: Command[] = Object.values(nav).filter(
  (c): c is Command =>
    typeof c === "object" &&
    c !== null &&
    "topics" in c &&
    (c as Command).topics.length > 0 &&
    (c as Command).topics.every(
      (t) => t === UpdateTopic.Frame || t === UpdateTopic.View
    )
);

describe("navigation commands are not edits (#468)", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    resetStore();
    dirtyFrameTracker.clear();
    ctx = new CommandContext();
  });

  // The issue's repro: one jump used to flag the autosave for a full rewrite.
  it("a jump moves the frame without dirtying autosave or adding an undo step", async () => {
    setup();
    dirtyFrameTracker.clear();
    await ctx.execute(nav.GoNextUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(5);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
    expect(dirtyFrameTracker.peekFrames()).toEqual([]);
    expect(undoDepth(ctx)).toBe(0);
    expect(ctx.canUndo).toBe(false);
  });

  // Guards the whole family, so a new Go command can't quietly become an edit.
  it("covers every Frame-only navigation command, including the suggestion jumps", async () => {
    const names = NAV_COMMANDS.map((c) => c.name);
    expect(names).toContain("GoNextSuggestion");
    expect(names).toContain("GoPrevSuggestion");
    expect(names).toContain("GoNextLabeledFrame");
    expect(names).toContain("GoToFrame");
    expect(names).toContain("MarkQcFlagOk");

    setup();
    for (const cmd of NAV_COMMANDS) {
      dirtyFrameTracker.clear();
      await ctx.execute(cmd, { frameIdx: 7 });
      expect({ cmd: cmd.name, undo: undoDepth(ctx) }).toEqual({ cmd: cmd.name, undo: 0 });
      expect({ cmd: cmd.name, full: dirtyFrameTracker.needsFullSnapshot }).toEqual({
        cmd: cmd.name,
        full: false,
      });
      expect({ cmd: cmd.name, frames: dirtyFrameTracker.peekFrames() }).toEqual({
        cmd: cmd.name,
        frames: [],
      });
    }
  });

  // The suggestion jump still lands on the suggestion after its topic change.
  it("GoNextSuggestion still goes to the next suggestion", async () => {
    setup();
    await ctx.execute(nav.GoNextSuggestion);
    expect(useAppStore.getState().frameIdx).toBe(8);
  });

  // ⌘Z after browsing must undo the user's edit, not the jump.
  it("undo after a jump undoes the last real edit", async () => {
    const { labels } = setup();
    await ctx.execute(NudgePoint); // edits frame 0
    expect(firstX(labels, 0)).toBe(110);

    await ctx.execute(nav.GoNextUserFrame); // → 5
    await ctx.execute(nav.GoToFrame, { frameIdx: 42 });
    expect(undoDepth(ctx)).toBe(1);
    expect(ctx.undoCommandName).toBe("NudgePoint");

    expect(ctx.undo()).toBe(true);
    expect(firstX(labels, 0)).toBe(10);
    expect(ctx.canUndo).toBe(false);
  });

  // Browsing between undo and redo used to wipe the redo stack.
  it("a jump keeps the redo stack", async () => {
    const { labels } = setup();
    await ctx.execute(NudgePoint);
    ctx.undo();
    expect(redoDepth(ctx)).toBe(1);

    await ctx.execute(nav.GoNextUserFrame);
    expect(redoDepth(ctx)).toBe(1);
    expect(ctx.redoCommandName).toBe("NudgePoint");

    expect(ctx.redo()).toBe(true);
    expect(firstX(labels, 0)).toBe(110);
  });

  // Frame listeners (e.g. panels following the playhead) still get the signal.
  it("still signals Frame listeners", async () => {
    setup();
    const heard: UpdateTopic[][] = [];
    ctx.onUpdate((topics) => heard.push(topics));
    await ctx.execute(nav.GoNextUserFrame);
    expect(heard).toEqual([[UpdateTopic.Frame]]);
  });

  // An edit that also touches Frame (e.g. AddInstance) is still an edit.
  it("a command with Frame plus a data topic still records an undo step", async () => {
    setup();
    await ctx.execute({
      name: "AddInstance",
      topics: [UpdateTopic.Frame, UpdateTopic.Instance],
      execute: () => {},
    });
    expect(undoDepth(ctx)).toBe(1);
    expect(dirtyFrameTracker.peekFrames().length).toBe(1);
  });

  // View-only commands (zoom, layout) are navigation too.
  it("a View-only command records no undo step", async () => {
    setup();
    await ctx.execute({ name: "ZoomIn", topics: [UpdateTopic.View], execute: () => {} });
    expect(undoDepth(ctx)).toBe(0);
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
  });
});
