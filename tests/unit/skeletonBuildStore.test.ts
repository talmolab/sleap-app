/**
 * Tests for the skeleton-builder store slice (Task 3 of the visual skeleton
 * builder). This slice is a pure scratch buffer: the clicked node positions
 * live ONLY in `builderPositions` and are discarded on exit. Entering/exiting
 * build mode MUST NOT touch `labels` or `skeleton` (the net-neutral invariant).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { Skeleton } from "@talmolab/sleap-io.js";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";

/** Reset the store between tests (mirrors appStore.test.ts). */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** A real sleap-io Skeleton with `n` nodes named a, b, c, ... */
function makeSkeleton(names: string[]): Skeleton {
  return new Skeleton({ nodes: names, name: "test" });
}

describe("skeletonBuildStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("has correct build-mode defaults", () => {
    const state = useAppStore.getState();
    expect(state.skeletonBuildMode).toBe(false);
    expect(state.skeletonBuildStage).toBe("place");
    expect(state.builderPositions).toEqual([]);
  });

  it("enterSkeletonBuild seeds one null slot per skeleton node", () => {
    const skeleton = makeSkeleton(["a", "b", "c"]);
    useAppStore.setState({ skeleton });

    useAppStore.getState().enterSkeletonBuild();

    const state = useAppStore.getState();
    expect(state.skeletonBuildMode).toBe(true);
    expect(state.skeletonBuildStage).toBe("place");
    expect(state.builderPositions).toHaveLength(3);
    expect(state.builderPositions.every((p) => p === null)).toBe(true);
  });

  it("enterSkeletonBuild with no skeleton yields empty positions", () => {
    useAppStore.setState({ skeleton: null });

    useAppStore.getState().enterSkeletonBuild();

    const state = useAppStore.getState();
    expect(state.skeletonBuildMode).toBe(true);
    expect(state.builderPositions).toEqual([]);
  });

  it("enterSkeletonBuild resets place-labeling overlap", () => {
    const skeleton = makeSkeleton(["a", "b"]);
    useAppStore.setState({
      skeleton,
      labelingMode: "place",
      placementNodeIdx: 1,
    });

    useAppStore.getState().enterSkeletonBuild();

    const state = useAppStore.getState();
    expect(state.labelingMode).toBe("select");
    expect(state.placementNodeIdx).toBeNull();
  });

  it("setBuilderPosition updates one slot immutably, leaving others intact", () => {
    const skeleton = makeSkeleton(["a", "b", "c"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();

    const before = useAppStore.getState().builderPositions;
    useAppStore.getState().setBuilderPosition(1, { x: 5, y: 6 });
    const after = useAppStore.getState().builderPositions;

    expect(after[0]).toBeNull();
    expect(after[1]).toEqual({ x: 5, y: 6 });
    expect(after[2]).toBeNull();
    // New array reference (so React/Zustand sees the change).
    expect(after).not.toBe(before);
  });

  it("setBuilderPosition can clear a slot back to null", () => {
    const skeleton = makeSkeleton(["a", "b"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();

    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 2 });
    useAppStore.getState().setBuilderPosition(0, null);

    expect(useAppStore.getState().builderPositions[0]).toBeNull();
  });

  it("setBuilderPosition grows the array with nulls for an out-of-range index", () => {
    // Start with an empty positions array (no skeleton).
    useAppStore.getState().enterSkeletonBuild();
    expect(useAppStore.getState().builderPositions).toEqual([]);

    useAppStore.getState().setBuilderPosition(3, { x: 9, y: 9 });

    const positions = useAppStore.getState().builderPositions;
    expect(positions).toHaveLength(4);
    expect(positions[0]).toBeNull();
    expect(positions[1]).toBeNull();
    expect(positions[2]).toBeNull();
    expect(positions[3]).toEqual({ x: 9, y: 9 });
  });

  it("syncBuilderPositions grows to a larger node count, preserving entries", () => {
    const skeleton = makeSkeleton(["a", "b"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 1 });
    useAppStore.getState().setBuilderPosition(1, { x: 2, y: 2 });

    // A node was added to the skeleton.
    useAppStore.setState({ skeleton: makeSkeleton(["a", "b", "c"]) });
    useAppStore.getState().syncBuilderPositions();

    const positions = useAppStore.getState().builderPositions;
    expect(positions).toHaveLength(3);
    expect(positions[0]).toEqual({ x: 1, y: 1 });
    expect(positions[1]).toEqual({ x: 2, y: 2 });
    expect(positions[2]).toBeNull();
  });

  it("syncBuilderPositions trims to a smaller node count, preserving survivors", () => {
    const skeleton = makeSkeleton(["a", "b", "c"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 1 });
    useAppStore.getState().setBuilderPosition(2, { x: 3, y: 3 });

    // A node was removed from the skeleton.
    useAppStore.setState({ skeleton: makeSkeleton(["a", "b"]) });
    useAppStore.getState().syncBuilderPositions();

    const positions = useAppStore.getState().builderPositions;
    expect(positions).toHaveLength(2);
    expect(positions[0]).toEqual({ x: 1, y: 1 });
    expect(positions[1]).toBeNull();
  });

  it("syncBuilderPositions with no skeleton yields an empty array", () => {
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(2, { x: 1, y: 1 });
    useAppStore.setState({ skeleton: null });

    useAppStore.getState().syncBuilderPositions();

    expect(useAppStore.getState().builderPositions).toEqual([]);
  });

  it("setSkeletonBuildStage updates the stage", () => {
    useAppStore.getState().enterSkeletonBuild();
    expect(useAppStore.getState().skeletonBuildStage).toBe("place");

    useAppStore.getState().setSkeletonBuildStage("connect");
    expect(useAppStore.getState().skeletonBuildStage).toBe("connect");

    useAppStore.getState().setSkeletonBuildStage("place");
    expect(useAppStore.getState().skeletonBuildStage).toBe("place");
  });

  it("exitSkeletonBuild resets the three fields and leaves skeleton/labels untouched", () => {
    const skeleton = makeSkeleton(["a", "b", "c"]);
    const labels = { sentinel: true } as unknown as ReturnType<
      typeof useAppStore.getState
    >["labels"];
    useAppStore.setState({ skeleton, labels });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setSkeletonBuildStage("connect");
    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 2 });

    useAppStore.getState().exitSkeletonBuild();

    const state = useAppStore.getState();
    expect(state.skeletonBuildMode).toBe(false);
    expect(state.skeletonBuildStage).toBe("place");
    expect(state.builderPositions).toEqual([]);
    // Net-neutral invariant at the store level: no phantom writes.
    expect(state.skeleton).toBe(skeleton);
    expect(state.labels).toBe(labels);
  });
});

describe("skeletonTemplateLayout (session template for Add Instance)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("defaults to null", () => {
    expect(useAppStore.getState().skeletonTemplateLayout).toBeNull();
  });

  it("captureSkeletonTemplateLayout snapshots builderPositions into a distinct array copy", () => {
    const skeleton = makeSkeleton(["a", "b", "c"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 2 });
    useAppStore.getState().setBuilderPosition(2, { x: 5, y: 6 });

    useAppStore.getState().captureSkeletonTemplateLayout();

    const layout = useAppStore.getState().skeletonTemplateLayout;
    expect(layout).toEqual([{ x: 1, y: 2 }, null, { x: 5, y: 6 }]);
    // Distinct array (a copy), not the live builderPositions reference.
    expect(layout).not.toBe(useAppStore.getState().builderPositions);
  });

  it("captured layout is a snapshot: later builder edits don't mutate it", () => {
    const skeleton = makeSkeleton(["a", "b"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(0, { x: 1, y: 1 });

    useAppStore.getState().captureSkeletonTemplateLayout();

    // Move a builder node AFTER capturing — the snapshot must not follow.
    useAppStore.getState().setBuilderPosition(0, { x: 99, y: 99 });

    expect(useAppStore.getState().skeletonTemplateLayout?.[0]).toEqual({ x: 1, y: 1 });
  });

  it("captureSkeletonTemplateLayout with empty positions yields null", () => {
    // No skeleton -> builderPositions is [].
    useAppStore.getState().enterSkeletonBuild();
    expect(useAppStore.getState().builderPositions).toEqual([]);

    useAppStore.getState().captureSkeletonTemplateLayout();

    expect(useAppStore.getState().skeletonTemplateLayout).toBeNull();
  });

  it("clearSkeletonTemplateLayout resets to null", () => {
    const skeleton = makeSkeleton(["a"]);
    useAppStore.setState({ skeleton });
    useAppStore.getState().enterSkeletonBuild();
    useAppStore.getState().setBuilderPosition(0, { x: 7, y: 8 });
    useAppStore.getState().captureSkeletonTemplateLayout();
    expect(useAppStore.getState().skeletonTemplateLayout).not.toBeNull();

    useAppStore.getState().clearSkeletonTemplateLayout();

    expect(useAppStore.getState().skeletonTemplateLayout).toBeNull();
  });

  it("is transient (not persisted)", () => {
    expect(PERSISTED_KEYS).not.toContain("skeletonTemplateLayout");
  });
});
