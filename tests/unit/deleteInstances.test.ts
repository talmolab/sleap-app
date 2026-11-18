// Why: the Grid deletes instances on many frames at once; one ⌘Z must bring all of them back.
import { describe, it, expect, beforeEach } from "../bun-test";
import { DeleteInstances } from "@/commands/editCommands";
import type { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { loadFixtureWithOneInstance } from "./helpers/automationFixture";

describe("DeleteInstances", () => {
  let ctx: CommandContext;
  beforeEach(() => {
    ctx = loadFixtureWithOneInstance().ctx;
  });

  it("deletes instances on several frames and undoes in one step", async () => {
    const labels = useAppStore.getState().labels!;
    const [f10, f20] = labels.labeledFrames;
    const a = f10.instances[0];
    const b = f20.instances[1];
    await ctx.execute(DeleteInstances, { instances: [a, b] });
    expect(f10.instances).toEqual([]);
    expect(f20.instances.length).toBe(1);
    expect(useAppStore.getState().instance).toBeNull(); // a was selected
    expect(ctx.undo()).toBe(true);
    const after = useAppStore.getState().labels!;
    expect(after.labeledFrames.find((f) => f.frameIdx === 10)!.instances.length).toBe(1);
    expect(after.labeledFrames.find((f) => f.frameIdx === 20)!.instances.length).toBe(2);
    expect(ctx.canUndo).toBe(false);
  });

  it("does nothing (no undo step) for instances not in the project", async () => {
    const { makeAutomationProject } = await import("./helpers/automationFixture");
    const stranger = makeAutomationProject().labels.labeledFrames[0].instances[0];
    await ctx.execute(DeleteInstances, { instances: [stranger] });
    expect(ctx.canUndo).toBe(false);
  });
});
