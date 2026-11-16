/**
 * Several skeletons in one project (e.g. mice + 1-node pellets on one video).
 *
 * Covers the first slice: add a second skeleton, pick the active one, add /
 * edit / undo instances of either on the same frame, draw each with its own
 * skeleton, save + reopen the .slp intact, single-skeleton projects unchanged,
 * and clear refusals in workflows that still need one skeleton.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

// Toasts are fire-and-forget; stub them so guards can be asserted on.
const toastInfo = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: toastInfo,
    warning: vi.fn(),
  },
}));

import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import {
  AddInstance,
  CopyInstance,
  PasteInstance,
  DuplicateInstance,
} from "@/commands/editCommands";
import {
  AddNodeCommand,
  AddSkeletonCommand,
  DeleteNodeCommand,
  LoadSkeletonTemplateCommand,
  RenameSkeletonCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import { ExportCSVCommand } from "@/commands/fileCommands";
import { instanceGeometry } from "@/canvas/instanceGeometry";
import { placeInstance } from "@/lib/instancePlacement";
import { parseSkeletonFile } from "@/lib/skeletonIO";
import { scoreLabelsAnomaly } from "@/lib/analyze/qc/anomaly";
import {
  hasMultipleSkeletons,
  isValidSkeletonName,
  multiSkeletonBlock,
  nextSkeletonName,
} from "@/lib/multiSkeleton";
import {
  LabeledFrame,
  Labels,
  Video,
  loadSlp,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";
import {
  makeMouseSkeleton,
  makeTwoSkeletonProject,
  placedInstance,
} from "./multiSkeletonFixture";

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

let ctx: CommandContext;

function setup() {
  const project = makeTwoSkeletonProject();
  useAppStore.getState().setLabels(project.labels, "two.slp");
  useAppStore.getState().setFrameIdx(0);
  return project;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  ctx = new CommandContext();
  installSkeletonUndoInterceptor(ctx);
  toastInfo.mockClear();
});

describe("several skeletons: save and reopen", () => {
  // The user's ask (e): both skeletons and each instance's skeleton survive a
  // .slp round trip, so a mouse comes back a mouse and a pellet a pellet.
  it("round-trips both skeletons and each instance's skeleton through .slp", async () => {
    const { labels } = makeTwoSkeletonProject();
    const reloaded = await loadSlp(toArrayBuffer(await saveSlpToBytes(labels)), {
      openVideos: false,
    });

    expect(reloaded.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet"]);
    expect(reloaded.skeletons[0].edgeIndices).toEqual([
      [0, 1],
      [1, 2],
    ]);
    const frame0 = reloaded.labeledFrames.find((lf) => lf.frameIdx === 0)!;
    expect(frame0.instances.map((i) => i.skeleton.name)).toEqual(["mouse", "mouse", "pellet"]);
    expect(frame0.instances.map((i) => i.points.length)).toEqual([3, 3, 1]);
    // Same skeleton OBJECT for instances of one skeleton (not per-instance copies).
    expect(frame0.instances[0].skeleton).toBe(reloaded.skeletons[0]);
    expect(frame0.instances[2].skeleton).toBe(reloaded.skeletons[1]);
    expect(frame0.instances[2].points[0].xy).toEqual([200, 300]);
  });

  // A skeleton added through the app (not the fixture) must also be written.
  it("saves a skeleton added in the app with its instances", async () => {
    const { labels } = setup();
    await ctx.execute(AddSkeletonCommand, { name: "cage" });
    await ctx.execute(AddNodeCommand, { name: "corner" });
    await ctx.execute(AddInstance);

    const reloaded = await loadSlp(toArrayBuffer(await saveSlpToBytes(labels)), {
      openVideos: false,
    });
    expect(reloaded.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet", "cage"]);
    const frame0 = reloaded.labeledFrames.find((lf) => lf.frameIdx === 0)!;
    expect(frame0.instances.map((i) => i.skeleton.name)).toEqual([
      "mouse",
      "mouse",
      "pellet",
      "cage",
    ]);
  });
});

describe("several skeletons: adding and choosing the active skeleton", () => {
  // (a) Add a second skeleton: it's appended empty and becomes active.
  it("AddSkeleton appends an empty skeleton and makes it active", async () => {
    const { labels } = setup();
    await ctx.execute(AddSkeletonCommand, { name: "food" });

    expect(labels.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet", "food"]);
    expect(useAppStore.getState().skeleton).toBe(labels.skeletons[2]);
    expect(labels.skeletons[2].nodes).toEqual([]);
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  // Names identify skeletons in the picker, so blanks and duplicates are refused.
  it("AddSkeleton refuses a blank or duplicate name", async () => {
    const { labels } = setup();
    await ctx.execute(AddSkeletonCommand, { name: "  " });
    await ctx.execute(AddSkeletonCommand, { name: "pellet" });
    expect(labels.skeletons.length).toBe(2);
    expect(isValidSkeletonName("pellet", labels.skeletons)).toBe(false);
    expect(nextSkeletonName(labels.skeletons)).toBe("skeleton 3");
  });

  // Undo must drop the skeleton AND move the active skeleton off it.
  it("undo of AddSkeleton removes it and re-activates the first skeleton", async () => {
    const { labels, mouse } = setup();
    await ctx.execute(AddSkeletonCommand, { name: "food" });
    ctx.undo();
    expect(labels.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet"]);
    expect(useAppStore.getState().skeleton).toBe(mouse);
    ctx.redo();
    expect(labels.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet", "food"]);
  });

  // (b) Choosing the active skeleton is a view change, not an edit.
  it("setActiveSkeleton switches without marking the project changed", () => {
    const { pellet } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    expect(useAppStore.getState().skeleton).toBe(pellet);
    expect(useAppStore.getState().hasChanges).toBe(false);
    expect(ctx.canUndo).toBe(false);
  });

  // A skeleton from another project can never become active here.
  it("setActiveSkeleton ignores a skeleton that isn't in the project", () => {
    const { mouse } = setup();
    useAppStore.getState().setActiveSkeleton(makeMouseSkeleton());
    expect(useAppStore.getState().skeleton).toBe(mouse);
  });

  // Renaming is undoable and keeps names unique.
  it("RenameSkeleton renames the active skeleton and undoes", async () => {
    const { pellet, labels } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    await ctx.execute(RenameSkeletonCommand, { newName: "mouse" }); // taken
    expect(pellet.name).toBe("pellet");
    await ctx.execute(RenameSkeletonCommand, { newName: "food" });
    expect(pellet.name).toBe("food");
    ctx.undo();
    expect(pellet.name).toBe("pellet");
    expect(labels.skeletons[1]).toBe(pellet);
  });
});

describe("several skeletons: instances of either skeleton on one frame", () => {
  // (c) New instances get the ACTIVE skeleton; both kinds share the frame.
  it("AddInstance uses the active skeleton", async () => {
    const { f0, mouse, pellet } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    await ctx.execute(AddInstance);
    const added = f0.instances[f0.instances.length - 1];
    expect(added.skeleton).toBe(pellet);
    expect(added.points.length).toBe(1);

    useAppStore.getState().setActiveSkeleton(mouse);
    await ctx.execute(AddInstance);
    const added2 = f0.instances[f0.instances.length - 1];
    expect(added2.skeleton).toBe(mouse);
    expect(added2.points.length).toBe(3);
    expect(f0.instances.map((i) => i.skeleton.name)).toEqual([
      "mouse",
      "mouse",
      "pellet",
      "pellet",
      "mouse",
    ]);
  });

  // Undo of an added instance removes just that instance, of either skeleton.
  it("undo removes the added pellet instance and leaves the mice", async () => {
    const { f0, pellet } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    await ctx.execute(AddInstance);
    expect(f0.instances.length).toBe(4);
    ctx.undo();
    const lf = useAppStore.getState().labels!.find({ video: f0.video, frameIdx: 0 })[0];
    expect(lf.instances.map((i) => i.skeleton.name)).toEqual(["mouse", "mouse", "pellet"]);
  });

  // Points are positional: a pasted mouse must stay a mouse even while the
  // pellet skeleton is active (else 3 points would sit on a 1-node skeleton).
  it("paste and clone keep the source instance's skeleton", async () => {
    const { f0, pellet, mouse } = setup();
    useAppStore.getState().setInstance(f0.instances[0]);
    await ctx.execute(CopyInstance);
    useAppStore.getState().setActiveSkeleton(pellet);
    await ctx.execute(PasteInstance);
    const pasted = f0.instances[f0.instances.length - 1];
    expect(pasted.skeleton).toBe(mouse);
    expect(pasted.points.length).toBe(3);

    await ctx.execute(DuplicateInstance, { instance: f0.instances[2] });
    const cloned = f0.instances[f0.instances.length - 1];
    expect(cloned.skeleton).toBe(pellet);
    expect(cloned.points.length).toBe(1);
  });

  // "Copy from prior frame" must not seed a new pellet from a mouse.
  it("prior-frame placement copies only from instances of the same skeleton", () => {
    const { f0, pellet, video } = setup();
    const inst = placeInstance("prior_frame", pellet, video, [], f0);
    expect(inst.skeleton).toBe(pellet);
    expect(inst.points[0].xy).toEqual([200, 300]); // the pellet, not a mouse head
  });
});

describe("several skeletons: editing one skeleton leaves the other alone", () => {
  // Adding a node to the mouse must not grow pellet instances.
  it("AddNode / DeleteNode only touch instances of the edited skeleton", async () => {
    const { f0, f10 } = setup();
    await ctx.execute(AddNodeCommand, { name: "nose" });
    expect(f0.instances.map((i) => i.points.length)).toEqual([4, 4, 1]);
    expect(f10.instances.map((i) => i.points.length)).toEqual([4, 1]);
    await ctx.execute(DeleteNodeCommand, { nodeIdx: 0 });
    expect(f0.instances.map((i) => i.points.length)).toEqual([3, 3, 1]);
    expect(f0.instances[2].points[0].xy).toEqual([200, 300]);
  });

  // Undo restores the skeleton the edit was made on, even if the user has
  // switched the active skeleton since, and never re-points pellets at mice.
  it("undo of a mouse edit after switching to the pellet restores the mouse", async () => {
    const { f0, mouse, pellet } = setup();
    await ctx.execute(AddNodeCommand, { name: "nose" });
    useAppStore.getState().setActiveSkeleton(pellet);
    ctx.undo();

    expect(mouse.nodeNames).toEqual(["head", "body", "tail"]);
    expect(pellet.nodeNames).toEqual(["centroid"]);
    const lf = useAppStore.getState().labels!.find({ video: f0.video, frameIdx: 0 })[0];
    expect(lf.instances.map((i) => i.skeleton)).toEqual([mouse, mouse, pellet]);
    expect(lf.instances.map((i) => i.points.length)).toEqual([3, 3, 1]);

    ctx.redo();
    expect(mouse.nodeNames).toEqual(["head", "body", "tail", "nose"]);
    expect(pellet.nodeNames).toEqual(["centroid"]);
  });

  // Loading a template onto the pellet must not wipe the mice.
  it("LoadSkeletonTemplate on the pellet leaves mouse instances intact", async () => {
    const { f0, pellet } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    await ctx.execute(LoadSkeletonTemplateCommand, { templateId: "fly32" });
    expect(f0.instances[0].points.length).toBe(3);
    expect(f0.instances[0].points[0].xy).toEqual([100, 100]);
    expect(f0.instances[2].points.length).toBe(pellet.nodes.length);
  });
});

describe("single-skeleton projects behave as before", () => {
  // With one skeleton, edits still reach EVERY instance — including a stray one
  // whose skeleton object isn't in labels.skeletons (the pre-multi behavior).
  it("AddNode still updates every instance and undo re-points them", async () => {
    const skeleton = makeMouseSkeleton();
    const stray = makeMouseSkeleton();
    const video = new Video({
      filename: "one.mp4",
      backendMetadata: { shape: [10, 64, 64, 3] },
      openBackend: false,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(placedInstance(skeleton, [1, 1]), placedInstance(stray, [5, 5]));
    labels.labeledFrames.push(lf);
    useAppStore.getState().setLabels(labels, "one.slp");

    await ctx.execute(AddNodeCommand, { name: "nose" });
    expect(lf.instances.map((i) => i.points.length)).toEqual([4, 4]);
    ctx.undo();
    const live = useAppStore.getState().labels!.labeledFrames[0];
    expect(live.instances.map((i) => i.points.length)).toEqual([3, 3]);
    expect(live.instances.every((i) => i.skeleton === skeleton)).toBe(true);
    expect(hasMultipleSkeletons(labels)).toBe(false);
  });

  // The guards are no-ops on a one-skeleton project.
  it("guards let single-skeleton projects through", () => {
    const labels = new Labels({ skeletons: [makeMouseSkeleton()] });
    expect(multiSkeletonBlock(labels, "Training")).toBeNull();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe("several skeletons: drawing", () => {
  // (d) Each instance draws with its own skeleton's nodes and edges.
  it("instanceGeometry uses the instance's own skeleton, not the active one", () => {
    const { f0, pellet } = setup();
    useAppStore.getState().setActiveSkeleton(pellet);
    const mouseGeo = instanceGeometry(f0.instances[0], null);
    expect(mouseGeo.nodes.map((n) => n.name)).toEqual(["head", "body", "tail"]);
    expect(mouseGeo.edges).toEqual([
      { srcIdx: 0, dstIdx: 1 },
      { srcIdx: 1, dstIdx: 2 },
    ]);
    const pelletGeo = instanceGeometry(f0.instances[2], null);
    expect(pelletGeo.nodes.map((n) => n.name)).toEqual(["centroid"]);
    expect(pelletGeo.edges).toEqual([]);
  });
});

describe("workflows that still need one skeleton refuse clearly", () => {
  // The message names the feature so the user knows what isn't supported.
  it("multiSkeletonBlock returns and toasts a clear message", () => {
    const { labels } = makeTwoSkeletonProject();
    expect(multiSkeletonBlock(labels, "Training")).toBe(
      "Training with several skeletons isn't supported yet.",
    );
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  // Label QC's scorer would mix mouse and pellet poses into one model.
  it("Label QC refuses (store) and the scorer throws a clear error", async () => {
    const { labels } = makeTwoSkeletonProject();
    await useQcStore.getState().run(labels);
    expect(useQcStore.getState().state).toBe("idle");
    expect(() => scoreLabelsAnomaly(labels)).toThrow(
      "Label QC with several skeletons isn't supported yet.",
    );
  });

  // Analysis CSV/HDF5 lay data out on one skeleton (sleap-io.js skeletons[0]).
  it("Export CSV refuses instead of exporting the first skeleton only", async () => {
    setup();
    await ctx.execute(ExportCSVCommand);
    expect(toastInfo).toHaveBeenCalledWith(
      "Exporting analysis files with several skeletons isn't supported yet.",
      expect.anything(),
    );
  });

  // Loading "the" skeleton from a multi-skeleton .slp would have to guess.
  it("Load skeleton from a .slp with several skeletons refuses", async () => {
    const { labels } = makeTwoSkeletonProject();
    const bytes = await saveSlpToBytes(labels);
    await expect(parseSkeletonFile("two.slp", bytes)).rejects.toThrow(
      "Loading one skeleton from a file with several isn't supported yet.",
    );
  });
});
