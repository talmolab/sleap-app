/**
 * Undo history belongs to one project. Snapshots hold references into a single
 * Labels object (its frames, videos, skeletons, tracks) and are restored by
 * writing them into whatever `labels` is current — so a snapshot taken in one
 * project and undone in another grafted the old project's videos/skeletons/
 * frames into the new one. Replacing `labels` (open, New Project, draft
 * restore, open predictions — all via `setLabels`) must clear undo and redo.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { commandContext } from "@/commands/CommandContext";
import { NewProjectCommand } from "@/commands/fileCommands";
import type { Command } from "@/commands/types";
import { useAppStore } from "@/stores/appStore";
import { UpdateTopic } from "@/types";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** A one-video, one-labeled-frame project with a track. */
function makeProject(name: string) {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name });
  const video = new Video({
    filename: `${name}.mp4`,
    backendMetadata: { shape: [10, 64, 64, 1] },
    openBackend: false,
  });
  const track = new Track(`${name} track`);
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  labels.tracks.push(track);
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  inst.points.forEach((p, n) => {
    p.xy = [10 + n, 20 + n];
    p.visible = true;
    p.complete = true;
  });
  inst.track = track;
  lf.instances.push(inst);
  labels.labeledFrames.push(lf);
  return { labels, skeleton, video, track, lf };
}

/** Load a project and land on its labeled frame, as opening one does. */
function openProject(project: ReturnType<typeof makeProject>) {
  const store = useAppStore.getState();
  store.setLabels(project.labels, `${project.skeleton.name}.slp`);
  store.setLabeledFrame(project.lf);
}

/** A mutating command, so execute() takes the usual single-frame snapshot. */
const HideFirstNode: Command = {
  name: "HideFirstNode",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  execute(ctx) {
    const lf = ctx.state.labeledFrame;
    if (lf) lf.instances[0].points[0].visible = false;
    ctx.state.markChanged();
  },
};

describe("undo history across project replacement", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clears undo and redo when a different project is loaded", async () => {
    const a = makeProject("a");
    openProject(a);
    await commandContext.execute(HideFirstNode);
    await commandContext.execute(HideFirstNode);
    commandContext.undo();
    expect(commandContext.canUndo).toBe(true);
    expect(commandContext.canRedo).toBe(true);

    const b = makeProject("b");
    openProject(b);

    expect(commandContext.canUndo).toBe(false);
    expect(commandContext.canRedo).toBe(false);
    expect(commandContext.undoCommandName).toBeNull();
    expect(commandContext.redoCommandName).toBeNull();
    expect(commandContext.undo()).toBe(false);
    expect(commandContext.redo()).toBe(false);
  });

  it("undo after loading another project leaves that project untouched", async () => {
    const a = makeProject("a");
    openProject(a);
    await commandContext.execute(HideFirstNode);

    const b = makeProject("b");
    openProject(b);
    commandContext.undo();

    expect(b.labels.videos).toEqual([b.video]);
    expect(b.labels.skeletons).toEqual([b.skeleton]);
    expect(b.labels.tracks).toEqual([b.track]);
    expect(b.labels.labeledFrames).toEqual([b.lf]);
    expect(b.lf.instances[0].points[0].visible).toBe(true);
  });

  it("undo after New Project does not bring back the previous project", async () => {
    const a = makeProject("a");
    openProject(a);
    await commandContext.execute(HideFirstNode);
    // Saved, so New Project's unsaved-work guard doesn't prompt.
    useAppStore.getState().clearChanges();

    await commandContext.execute(NewProjectCommand);
    const fresh = useAppStore.getState().labels!;
    expect(fresh).not.toBe(a.labels);
    expect(commandContext.canUndo).toBe(false);

    commandContext.undo();

    expect(fresh.videos).toEqual([]);
    expect(fresh.tracks).toEqual([]);
    expect(fresh.labeledFrames).toEqual([]);
    expect(fresh.skeletons).toHaveLength(1);
    expect(fresh.skeletons[0]).not.toBe(a.skeleton);
  });

  it("keeps history through edits and navigation within the same project", async () => {
    const a = makeProject("a");
    openProject(a);
    await commandContext.execute(HideFirstNode);

    const store = useAppStore.getState();
    store.setFrameIdx(5);
    store.setFrameIdx(0);
    store.setLabeledFrame(a.lf);
    store.markChanged();

    expect(commandContext.canUndo).toBe(true);
    expect(commandContext.undo()).toBe(true);
    expect(a.lf.instances[0].points[0].visible).toBe(true);
  });
});
