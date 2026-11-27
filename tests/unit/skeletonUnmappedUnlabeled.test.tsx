/**
 * Tests for `unmapped: "unlabeled" | "absent"` across skeleton edits:
 *   - `AddNodeCommand` + Undo/Redo + SLP 3.0 round-trip
 *   - `remapInstancePoints` & `OpenSkeletonCommand` + Undo/Redo
 *   - `<SkeletonPanel />` Add Node dialog smart defaults & visibility
 *   - `<ReplaceSkeletonDialog />` unmapped-node selector & forwarding
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
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
import { remapInstancePoints, type SkeletonDiff, type UnmappedNodeFill } from "@/lib/skeletonIO";

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const { useAppStore } = await import("@/stores/appStore");
const { CommandContext } = await import("@/commands/CommandContext");
const {
  AddNodeCommand,
  OpenSkeletonCommand,
  installSkeletonUndoInterceptor,
} = await import("@/commands/skeletonCommands");
const { ReplaceSkeletonDialog } = await import(
  "@/components/panels/ReplaceSkeletonDialog"
);
const { SkeletonPanel } = await import("@/components/panels/SkeletonPanel");

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

function makeProject(withInstance = true, format3 = false) {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
  const video = new Video({
    filename: "session.mp4",
    backendMetadata: { shape: [50, 64, 64, 1] },
    openBackend: false,
  });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [10, 20], visible: true, complete: true },
      { xy: [30, 40], visible: true, complete: true },
    ],
  });
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: withInstance
      ? [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })]
      : [],
  });
  if (format3) {
    labels.sourceFormat = Object.freeze({
      formatId: 3,
      access: "keep" as const,
      summary: {
        formatId: 3,
        unlabeledPoints: 0,
        unlabeledUserPoints: 0,
        unlabeledPredictedPoints: 0,
        metadataKeys: { instances: [], frames: [], bboxes: [] },
        unknownColumns: [],
        unreadTables: [],
        lossless: false,
      },
      labelsPath: "/data/f3.slp",
    });
  }
  useAppStore.getState().setLabels(labels, format3 ? "f3.slp" : "f2.slp");
  useAppStore.getState().setVideo(video);
  return { labels, skeleton, video, inst };
}

describe("AddNodeCommand unmapped handling", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("marks new node as unlabeled when unmapped='unlabeled', round-trips SLP 3.0, and undoes/redoes cleanly", async () => {
    const { labels, skeleton } = makeProject(true, false);
    const ctx = new CommandContext();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(AddNodeCommand, { name: "ear", unmapped: "unlabeled" });

    expect(skeleton.nodeNames).toEqual(["head", "tail", "ear"]);
    const inst = labels.labeledFrames[0].instances[0];
    expect(inst.points).toHaveLength(3);
    expect(isUnlabeledPoint(inst.points[2])).toBe(true);
    expect(Number.isNaN(inst.points[2].xy[0])).toBe(true);

    // Persists through SLP 3.0 serialization.
    const reloaded = await loadSlp(await saveSlpToBytes(labels), { openVideos: false });
    expect(reloaded.sourceFormat?.formatId).toBe(3);
    expect(isUnlabeledPoint(reloaded.labeledFrames[0].instances[0].points[2])).toBe(true);

    // Undo removes the node and point.
    expect(ctx.undo()).toBe(true);
    expect(skeleton.nodeNames).toEqual(["head", "tail"]);
    expect(labels.labeledFrames[0].instances[0].points).toHaveLength(2);

    // Redo restores the unlabeled flag.
    expect(ctx.redo()).toBe(true);
    expect(skeleton.nodeNames).toEqual(["head", "tail", "ear"]);
    expect(isUnlabeledPoint(labels.labeledFrames[0].instances[0].points[2])).toBe(true);
  });

  it("defaults to absent (labeled !== false) when unmapped is omitted or 'absent'", async () => {
    const { labels } = makeProject(true, false);
    const ctx = new CommandContext();
    installSkeletonUndoInterceptor(ctx);

    await ctx.execute(AddNodeCommand, { name: "ear", unmapped: "absent" });
    const pt = labels.labeledFrames[0].instances[0].points[2];
    expect(isUnlabeledPoint(pt)).toBe(false);
    expect(pt.visible).toBe(false);
    expect(Number.isNaN(pt.xy[0])).toBe(true);
  });
});

describe("remapInstancePoints & OpenSkeletonCommand unmapped handling", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("marks only unlinked added nodes as unlabeled when unmapped='unlabeled'", async () => {
    const { labels, skeleton, inst } = makeProject(true, false);
    const imported = new Skeleton({ nodes: ["head", "rump", "left_ear"], name: "v2" });
    const linkMap = new Map([["rump", "tail"]]);

    const remapped = remapInstancePoints(inst, skeleton.nodes, imported.nodes, linkMap, "unlabeled");
    expect(remapped[0].xy).toEqual([10, 20]); // kept head
    expect(isUnlabeledPoint(remapped[0])).toBe(false);
    expect(remapped[1].xy).toEqual([30, 40]); // linked rump <- tail
    expect(isUnlabeledPoint(remapped[1])).toBe(false);
    expect(isUnlabeledPoint(remapped[2])).toBe(true); // added unlinked left_ear

    const ctx = new CommandContext();
    installSkeletonUndoInterceptor(ctx);
    await ctx.execute(OpenSkeletonCommand, {
      newSkeleton: imported,
      linkMap,
      unmapped: "unlabeled",
    });

    const live = labels.labeledFrames[0].instances[0];
    expect(skeleton.nodeNames).toEqual(["head", "rump", "left_ear"]);
    expect(live.points[1].xy).toEqual([30, 40]);
    expect(isUnlabeledPoint(live.points[2])).toBe(true);

    expect(ctx.undo()).toBe(true);
    expect(skeleton.nodeNames).toEqual(["head", "tail"]);
    expect(labels.labeledFrames[0].instances[0].points).toHaveLength(2);
  });
});

describe("SkeletonPanel Add Node dialog & ReplaceSkeletonDialog UI", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("hides the unmapped choice in Add Node when there are no existing instances", () => {
    makeProject(false, true);
    render(<SkeletonPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New Node" }));
    expect(screen.queryByTestId("add-node-unmapped")).toBeNull();
  });

  it("defaults Add Node to 'absent' on 2.x projects and 'unlabeled' on 3.0 projects", () => {
    makeProject(true, false);
    render(<SkeletonPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New Node" }));
    const group2 = screen.getByTestId("add-node-unmapped");
    expect(within(group2).getByRole("radio", { name: /Mark as Absent/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    cleanup();

    makeProject(true, true);
    render(<SkeletonPanel />);
    fireEvent.click(screen.getByRole("button", { name: "New Node" }));
    const group3 = screen.getByTestId("add-node-unmapped");
    expect(within(group3).getByRole("radio", { name: /Mark new node as Unlabeled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("ReplaceSkeletonDialog renders unmapped selector when instances and added nodes exist and forwards selection", () => {
    const diff: SkeletonDiff = {
      renameNodes: ["head"],
      deleteNodes: ["tail"],
      addNodes: ["ear"],
    };
    const confirmed: Array<{ map: Map<string, string>; unmapped: UnmappedNodeFill }> = [];

    render(
      <ReplaceSkeletonDialog
        open
        onOpenChange={() => {}}
        diff={diff}
        existingInstanceCount={4}
        defaultUnmapped="unlabeled"
        onConfirm={(map, unmapped) => confirmed.push({ map, unmapped })}
      />,
    );

    const box = screen.getByTestId("replace-skeleton-unmapped");
    expect(within(box).getByRole("radio", { name: /Mark as Unlabeled/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(within(box).getByRole("radio", { name: /Mark as Absent/i }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].unmapped).toBe("absent");
  });
});
