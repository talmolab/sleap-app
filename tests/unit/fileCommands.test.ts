/**
 * Tests for fileCommands. Covers the #138 PR-A fix that stops New Project from
 * dead-ending: it must seed an empty skeleton so the editor lands in a usable
 * state (the Skeleton panel + template dropdown require a non-null skeleton).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { NewProjectCommand } from "@/commands/fileCommands";
import { useAppStore } from "@/stores/appStore";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("NewProjectCommand", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("seeds an empty skeleton so New Project is usable, not a dead end (#138)", async () => {
    await ctx.execute(NewProjectCommand);
    const s = useAppStore.getState();

    expect(s.projectLoaded).toBe(true);
    // Exactly one skeleton, auto-selected, with zero nodes (ready for a template).
    expect(s.labels?.skeletons.length).toBe(1);
    expect(s.skeleton).not.toBeNull();
    expect(s.skeleton?.nodes.length).toBe(0);
    // No videos yet — the user adds one via the Videos panel.
    expect(s.labels?.videos.length).toBe(0);
  });
});
