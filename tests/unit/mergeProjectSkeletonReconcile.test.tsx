/**
 * Tests for differing-skeleton project merges (File ▸ Merge into Project…):
 *   - Pure diff + unified skeleton construction (`describeSkeletonMergeDiff`,
 *     `buildUnifiedSkeleton`, `reconcileSkeletonsInPlace`, `enumerateUnifiedConflicts`)
 *   - `MergeConflictsCommand` with `skeletonMode: "unify"` (`unmapped: "unlabeled"` vs
 *     `"absent"`) and `skeletonMode: "separate"`, including full Undo/Redo
 *   - `<MergeProjectDialog />` UI flow for reconciling differing skeletons
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import {
  Instance,
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";
import { isUnlabeledPoint } from "@/lib/slpFormat";

let pickResult: string[] | string | null = null;
const disk = new Map<string, Uint8Array>();
const platform = {
  isTauri: true,
  showOpenDialog: async () => pickResult,
  readFile: async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`No such file: ${path}`);
    return bytes;
  },
};

vi.mock("@/platform/index", () => ({
  getPlatform: async () => platform,
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@/lib/notify", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { commandContext } = await import("@/commands/CommandContext");
const { MergeConflictsCommand } = await import("@/commands/mergeConflictCommands");
const {
  describeSkeletonMergeDiff,
  buildUnifiedSkeleton,
  enumerateUnifiedConflicts,
} = await import("@/lib/mergeProject");
const { MergeProjectDialog } = await import("@/components/dialogs/MergeProjectDialog");

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

function makeVideo(dir: string) {
  return new Video({
    filename: `${dir}/session.mp4`,
    backendMetadata: { shape: [100, 64, 64, 1] },
    openBackend: false,
  });
}

function makeProject(nodes: string[], frameIdxs: number[], dir: string, name = "s"): Labels {
  const sk = new Skeleton({ nodes, name });
  if (nodes.length >= 2) sk.addEdge(sk.nodes[0], sk.nodes[1]);
  const v = makeVideo(dir);
  return new Labels({
    videos: [v],
    skeletons: [sk],
    labeledFrames: frameIdxs.map(
      (frameIdx) =>
        new LabeledFrame({
          video: v,
          frameIdx,
          instances: [
            Instance.fromArray(
              nodes.map((_, i) => [10 + i * 5, 20 + i * 5]),
              sk,
            ),
          ],
        }),
    ),
  });
}

describe("skeleton merge reconciliation helpers", () => {
  it("computes node diff and recommends unify when nodes overlap, separate when disjoint", async () => {
    const base = makeProject(["head", "tail"], [0], "/a");
    const overlap = makeProject(["nose", "ear", "tail"], [1], "/b", "mouse_v2");
    const disjoint = makeProject(["pellet_center"], [1], "/b", "pellet");

    const m1 = await base.match(overlap, { video: "basename", track: "name" });
    const d1 = describeSkeletonMergeDiff(base, overlap, m1);
    expect(d1).toEqual({
      canUnify: true,
      sharedNodes: ["tail"],
      baseOnlyNodes: ["head"],
      donorOnlyNodes: ["nose", "ear"],
      unionNodeCount: 4,
      defaultMode: "unify",
    });

    const m2 = await base.match(disjoint, { video: "basename", track: "name" });
    const d2 = describeSkeletonMergeDiff(base, disjoint, m2);
    expect(d2?.defaultMode).toBe("separate");
    expect(d2?.sharedNodes).toEqual([]);
  });

  it("buildUnifiedSkeleton preserves base node order, appends donor-only nodes, and unions edges/symmetries", () => {
    const base = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
    base.addEdge("head", "tail");
    const donor = new Skeleton({ nodes: ["tail", "left_ear", "right_ear"], name: "donor" });
    donor.addEdge("left_ear", "tail");
    donor.addSymmetry("left_ear", "right_ear");

    const unified = buildUnifiedSkeleton(base, donor);
    expect(unified.nodeNames).toEqual(["head", "tail", "left_ear", "right_ear"]);
    expect(unified.edges.map((e) => [e.source.name, e.destination.name])).toEqual([
      ["head", "tail"],
      ["left_ear", "tail"],
    ]);
    expect(unified.symmetryNames).toEqual([["left_ear", "right_ear"]]);
  });

  it("enumerateUnifiedConflicts detects overlapping poses on shared frames without mutating either side", async () => {
    const baseSk = new Skeleton({ nodes: ["head", "tail"], name: "s" });
    const donorSk = new Skeleton({ nodes: ["head", "tail", "ear"], name: "s2" });
    const v1 = makeVideo("/a");
    const v2 = makeVideo("/b");

    const baseInst = new Instance({
      skeleton: baseSk,
      points: [
        { xy: [10, 20], visible: true, complete: true },
        { xy: [30, 40], visible: true, complete: true },
      ],
    });
    const donorInst = new Instance({
      skeleton: donorSk,
      points: [
        { xy: [11, 20], visible: true, complete: true },
        { xy: [30, 41], visible: true, complete: true },
        { xy: [NaN, NaN], visible: false, complete: false },
      ],
    });

    const base = new Labels({
      videos: [v1],
      skeletons: [baseSk],
      labeledFrames: [new LabeledFrame({ video: v1, frameIdx: 5, instances: [baseInst] })],
    });
    const donor = new Labels({
      videos: [v2],
      skeletons: [donorSk],
      labeledFrames: [new LabeledFrame({ video: v2, frameIdx: 5, instances: [donorInst] })],
    });

    const conflicts = await enumerateUnifiedConflicts(base, donor, "unlabeled");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].baseInstances).toEqual([baseInst]);
    expect(conflicts[0].donorInstances).toEqual([donorInst]);
    // Neither project was mutated during preview.
    expect(base.skeletons[0].nodeNames).toEqual(["head", "tail"]);
    expect(donor.skeletons[0].nodeNames).toEqual(["head", "tail", "ear"]);
  });
});

describe("MergeConflictsCommand with differing skeletons", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    while (commandContext.canUndo) commandContext.undo();
    pickResult = null;
    disk.clear();
  });

  it("unifies skeletons with unmapped='unlabeled', round-trips SLP 3.0, and supports full Undo/Redo", async () => {
    const base = makeProject(["head", "tail"], [0], "/data", "mouse");
    const donor = makeProject(["nose", "ear", "tail"], [10], "/other", "mouse_ext");
    useAppStore.getState().setLabels(base, "base.slp");

    await commandContext.execute(MergeConflictsCommand, {
      other: donor,
      resolutions: [],
      skeletonMode: "unify",
      unmapped: "unlabeled",
    });

    expect(base.skeletons).toHaveLength(1);
    expect(base.skeletons[0].nodeNames).toEqual(["head", "tail", "nose", "ear"]);
    expect(base.labeledFrames.map((f) => f.frameIdx).sort((a, b) => a - b)).toEqual([0, 10]);

    const f0Inst = base.labeledFrames.find((f) => f.frameIdx === 0)!.instances[0];
    const f10Inst = base.labeledFrames.find((f) => f.frameIdx === 10)!.instances[0];

    // Base instance kept head & tail, and got nose & ear marked unlabeled (SLP 3.0).
    expect(f0Inst.points[0].xy).toEqual([10, 20]);
    expect(f0Inst.points[1].xy).toEqual([15, 25]);
    expect(isUnlabeledPoint(f0Inst.points[2])).toBe(true);
    expect(isUnlabeledPoint(f0Inst.points[3])).toBe(true);

    // Donor instance got head marked unlabeled, and kept tail, nose, ear.
    expect(isUnlabeledPoint(f10Inst.points[0])).toBe(true);
    expect(f10Inst.points[1].xy).toEqual([20, 30]); // donor's tail (idx 2)
    expect(f10Inst.points[2].xy).toEqual([10, 20]); // donor's nose (idx 0)
    expect(f10Inst.points[3].xy).toEqual([15, 25]); // donor's ear (idx 1)

    // Real SLP 3.0 round-trip preserves the unlabeled flags.
    const bytes = await saveSlpToBytes(base);
    const reloaded = await loadSlp(bytes, { openVideos: false });
    expect(reloaded.sourceFormat?.formatId).toBe(3);
    const r0 = reloaded.labeledFrames.find((f) => f.frameIdx === 0)!.instances[0];
    const r10 = reloaded.labeledFrames.find((f) => f.frameIdx === 10)!.instances[0];
    expect(isUnlabeledPoint(r0.points[2])).toBe(true);
    expect(isUnlabeledPoint(r10.points[0])).toBe(true);

    // Undo restores the original 2-node skeleton and 1 frame.
    expect(commandContext.undo()).toBe(true);
    const afterUndo = useAppStore.getState().labels!;
    expect(afterUndo.skeletons[0].nodeNames).toEqual(["head", "tail"]);
    expect(afterUndo.labeledFrames).toHaveLength(1);
    expect(afterUndo.labeledFrames[0].instances[0].points).toHaveLength(2);
    expect(afterUndo.labeledFrames[0].instances[0].points[0].xy).toEqual([10, 20]);

    // Redo restores the 4-node unified skeleton, both frames, and unlabeled flags.
    expect(commandContext.redo()).toBe(true);
    const afterRedo = useAppStore.getState().labels!;
    expect(afterRedo.skeletons[0].nodeNames).toEqual(["head", "tail", "nose", "ear"]);
    expect(afterRedo.labeledFrames).toHaveLength(2);
    const redo0 = afterRedo.labeledFrames.find((f) => f.frameIdx === 0)!.instances[0];
    expect(isUnlabeledPoint(redo0.points[2])).toBe(true);
  });

  it("unifies skeletons with unmapped='absent' without creating unlabeled points", async () => {
    const base = makeProject(["head", "tail"], [0], "/data");
    const donor = makeProject(["tail", "ear"], [10], "/other");
    useAppStore.getState().setLabels(base, "base.slp");

    await commandContext.execute(MergeConflictsCommand, {
      other: donor,
      resolutions: [],
      skeletonMode: "unify",
      unmapped: "absent",
    });

    const f0Inst = base.labeledFrames.find((f) => f.frameIdx === 0)!.instances[0];
    const f10Inst = base.labeledFrames.find((f) => f.frameIdx === 10)!.instances[0];
    expect(base.skeletons[0].nodeNames).toEqual(["head", "tail", "ear"]);
    expect(isUnlabeledPoint(f0Inst.points[2])).toBe(false);
    expect(Number.isNaN(f0Inst.points[2].xy[0])).toBe(true);
    expect(isUnlabeledPoint(f10Inst.points[0])).toBe(false);
    expect(Number.isNaN(f10Inst.points[0].xy[0])).toBe(true);
  });

  it("keeps separate skeletons in multi-skeleton mode and undoes cleanly", async () => {
    const base = makeProject(["head", "tail"], [0], "/data", "mouse");
    const donor = makeProject(["p1", "p2"], [10], "/other", "pellet");
    useAppStore.getState().setLabels(base, "base.slp");

    await commandContext.execute(MergeConflictsCommand, {
      other: donor,
      resolutions: [],
      skeletonMode: "separate",
    });

    expect(base.skeletons).toHaveLength(2);
    expect(base.labeledFrames).toHaveLength(2);

    expect(commandContext.undo()).toBe(true);
    expect(useAppStore.getState().labels!.skeletons).toHaveLength(1);
    expect(useAppStore.getState().labels!.labeledFrames).toHaveLength(1);
  });

  it("MergeProjectDialog defaults to unifying overlapping skeletons with unlabeled nodes", async () => {
    const base = makeProject(["head", "tail"], [0], "/data", "mouse");
    const donorBytes = await saveSlpToBytes(
      makeProject(["nose", "ear", "tail"], [10], "/elsewhere", "mouse_ext"),
    );
    disk.set("/picked/ext.slp", donorBytes);

    useAppStore.getState().setLabels(base, "base.slp");
    useAppStore.getState().setMergeProjectDialogOpen(true);
    render(<MergeProjectDialog />);

    pickResult = ["/picked/ext.slp"];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Choose / }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("merge-skeleton-reconciliation")).toBeInTheDocument();
    });

    // Unify + Unlabeled are selected by default when skeletons share nodes.
    expect(screen.getByRole("radio", { name: /Unify skeletons/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("radio", { name: /Mark as Unlabeled \(SLP 3\.0\)/i }),
    ).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Merge$/ }));
    });
    await waitFor(() => expect(useAppStore.getState().mergeProjectDialogOpen).toBe(false));

    expect(base.skeletons).toHaveLength(1);
    expect(base.skeletons[0].nodeNames).toEqual(["head", "tail", "nose", "ear"]);
    const f0 = base.labeledFrames.find((f) => f.frameIdx === 0)!.instances[0];
    expect(isUnlabeledPoint(f0.points[2])).toBe(true);
  });
});
