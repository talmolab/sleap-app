// Why: SetNodes is how Claude's accepted fixes edit poses; it must be one undo step and a frame-level autosave.
import { describe, it, expect, beforeEach } from "../bun-test";
import { SetNodes } from "@/commands/editCommands";
import type { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { loadFixtureWithOneInstance } from "./helpers/automationFixture";

describe("SetNodes", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    ctx = loadFixtureWithOneInstance().ctx;
    dirtyFrameTracker.clear();
  });

  // Why: an accepted fix moves some nodes and hides others, and one ⌘Z must put all of it back.
  it("moves nodes, hides null nodes, and undoes in one step", async () => {
    const inst = useAppStore.getState().instance!;
    const before = inst.points.map((p) => [p.xy[0], p.xy[1], p.visible]);
    await ctx.execute(SetNodes, { nodes: { 0: [10, 20], 1: null } });
    const after = useAppStore.getState().instance!;
    expect(after.points[0].xy).toEqual([10, 20]);
    expect(after.points[1].visible).toBe(false);
    expect(after.points[2].xy).toEqual([130, 120]);
    expect(ctx.undo()).toBe(true);
    const restored = useAppStore.getState().instance!;
    expect(restored.points.map((p) => [p.xy[0], p.xy[1], p.visible])).toEqual(before);
    expect(ctx.canUndo).toBe(false);
  });

  // Why: without this, every accepted fix would force a full project rewrite on autosave.
  it("is a frame-level edit for autosave", async () => {
    await ctx.execute(SetNodes, { nodes: { 0: [1, 1] } });
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
    expect(dirtyFrameTracker.peekFrames().length).toBe(1);
  });

  // Why: the Edit menu and the ⌘Z toast should say what Claude's change was, not "Set Nodes".
  it("uses the given undo label", async () => {
    await ctx.execute(SetNodes, { nodes: { 0: [1, 1] } }, { undoLabel: "Claude: nose was on the ear" });
    expect(ctx.undoCommandName).toBe("Claude: nose was on the ear");
    expect(dirtyFrameTracker.needsFullSnapshot).toBe(false);
  });

  // Why: with no instance selected there's nothing to edit, and nothing should change.
  it("does nothing without a selected instance", async () => {
    useAppStore.getState().setInstance(null);
    await ctx.execute(SetNodes, { nodes: { 0: [1, 1] } });
    const lf = useAppStore.getState().labeledFrame;
    expect(lf?.instances[0].points[0].xy).toEqual([100, 100]);
  });
});
