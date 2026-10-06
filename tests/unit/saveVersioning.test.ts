/**
 * Save / Save As auto-versioning wiring (PyQt parity).
 *
 * The pure increment logic lives in versionedFilename.test.ts; here we verify
 * the COMMAND layer applies it the way PyQt does:
 *   - Save As always proposes the next .vNNN version and forces the dialog.
 *   - Save keeps a named project's filename (overwrite in place, no bump).
 *   - An untitled project proposes labels.v001.slp (seed labels.v000.slp → v001).
 *
 * We mock saveProjectAsSlp and assert the (filename, forceDialog) it receives,
 * so this doesn't depend on the platform save dialog.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

const saveMock = vi.fn(async () => {});
vi.mock("@/lib/saveProject", () => ({
  saveProjectAsSlp: saveMock,
}));

import { CommandContext } from "@/commands/CommandContext";
import {
  SaveProjectCommand,
  SaveAsProjectCommand,
} from "@/commands/fileCommands";
import { useAppStore } from "@/stores/appStore";

// The commands only guard on `if (!labels) return`, so a truthy stand-in is enough.
const fakeLabels = {} as never;

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ labels: fakeLabels });
}

describe("Save/Save As auto-versioning", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    saveMock.mockClear();
    ctx = new CommandContext();
  });

  it("Save As proposes the next .vNNN version and forces the dialog", async () => {
    useAppStore.setState({ filename: "labels.v001.slp" });
    await ctx.execute(SaveAsProjectCommand);
    expect(saveMock).toHaveBeenCalledWith(fakeLabels, "labels.v002.slp", true);
  });

  it("Save As starts versioning an unversioned name at .v001", async () => {
    useAppStore.setState({ filename: "experiment.slp" });
    await ctx.execute(SaveAsProjectCommand);
    expect(saveMock).toHaveBeenCalledWith(
      fakeLabels,
      "experiment.v001.slp",
      true
    );
  });

  it("Save As on an untitled project proposes labels.v001.slp", async () => {
    useAppStore.setState({ filename: null });
    await ctx.execute(SaveAsProjectCommand);
    expect(saveMock).toHaveBeenCalledWith(fakeLabels, "labels.v001.slp", true);
  });

  it("Save keeps a named project's filename (overwrite, no bump)", async () => {
    useAppStore.setState({ filename: "labels.v003.slp" });
    await ctx.execute(SaveProjectCommand);
    expect(saveMock).toHaveBeenCalledWith(fakeLabels, "labels.v003.slp");
  });

  it("Save on an untitled project proposes labels.v001.slp", async () => {
    useAppStore.setState({ filename: null });
    await ctx.execute(SaveProjectCommand);
    expect(saveMock).toHaveBeenCalledWith(fakeLabels, "labels.v001.slp");
  });
});
