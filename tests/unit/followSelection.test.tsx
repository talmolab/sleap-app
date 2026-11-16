/**
 * View ▸ Fit View to Selection as a toggle: it re-fits when the frame changes
 * (following the selected instance's track) and never because of a selection
 * change on the current frame — a mousedown on a node selects its instance,
 * and zooming then would make the dragged node jump.
 */
import { describe, it, expect } from "../bun-test";
import { renderHook } from "@testing-library/react";
import { useFollowSelection, followTarget, type FollowSelectionInputs } from "@/hooks/useFollowSelection";
import type { RenderedInstance } from "@/canvas/SkeletonRenderer";

function ri(trackName: string | null, over: Partial<RenderedInstance> = {}): RenderedInstance {
  return {
    nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName,
    visible: true,
    showNonVisible: true,
    ...over,
  };
}

/** Render the hook and collect what it fits to. */
function setup(initial: Omit<FollowSelectionInputs, "onFit">) {
  const fits: RenderedInstance[] = [];
  const onFit = (r: RenderedInstance) => fits.push(r);
  const hook = renderHook((props: Omit<FollowSelectionInputs, "onFit">) => useFollowSelection({ ...props, onFit }), {
    initialProps: initial,
  });
  return { fits, rerender: hook.rerender };
}

describe("useFollowSelection", () => {
  // Turning the toggle on with an instance selected zooms to it right away.
  it("fits the selected instance when turned on", () => {
    const frameA = {};
    const sel = ri("A", { isSelected: true });
    const { fits, rerender } = setup({
      followSelection: false, selectedTrackName: "A", hasSelection: true, frame: frameA, renderedInstances: [sel, ri("B")],
    });
    expect(fits).toEqual([]);
    rerender({ followSelection: true, selectedTrackName: "A", hasSelection: true, frame: frameA, renderedInstances: [sel, ri("B")] });
    expect(fits).toEqual([sel]);
  });

  // The bug a review caught: mousedown on a node selects its instance; that must not zoom mid-drag.
  it("doesn't fit when the selection changes or nodes move on the same frame", () => {
    const frameA = {};
    const { fits, rerender } = setup({
      followSelection: true, selectedTrackName: null, hasSelection: false, frame: frameA, renderedInstances: [ri("A"), ri("B")],
    });
    // Mousedown on B's node: B becomes selected.
    rerender({ followSelection: true, selectedTrackName: "B", hasSelection: true, frame: frameA, renderedInstances: [ri("A"), ri("B", { isSelected: true })] });
    // Dragging: the node moves, so the drawn instances are rebuilt.
    const moved = ri("B", { isSelected: true, nodes: [{ x: 9, y: 9, visible: true, complete: true, name: "n" }] });
    rerender({ followSelection: true, selectedTrackName: "B", hasSelection: true, frame: frameA, renderedInstances: [ri("A"), moved] });
    expect(fits).toEqual([]);
  });

  // Moving to the next frame clears the selection; the view follows the same track there.
  it("re-fits on frame change, following the last selected track", () => {
    const frameA = {};
    const frameB = {};
    const { fits, rerender } = setup({
      followSelection: true, selectedTrackName: "B", hasSelection: true, frame: frameA, renderedInstances: [ri("A"), ri("B", { isSelected: true })],
    });
    fits.length = 0;
    const bOnNext = ri("B");
    rerender({ followSelection: true, selectedTrackName: null, hasSelection: false, frame: frameB, renderedInstances: [ri("A"), bOnNext] });
    expect(fits).toEqual([bOnNext]);
  });

  // With the toggle off, frame changes leave the view alone.
  it("does nothing when off", () => {
    const { fits, rerender } = setup({
      followSelection: false, selectedTrackName: "B", hasSelection: true, frame: {}, renderedInstances: [ri("B", { isSelected: true })],
    });
    rerender({ followSelection: false, selectedTrackName: null, hasSelection: false, frame: {}, renderedInstances: [ri("B")] });
    expect(fits).toEqual([]);
  });
});

describe("followTarget", () => {
  // A selection on the new frame (e.g. Label QC's go-to-flag) beats the remembered track.
  it("prefers the selected instance, then a user instance on the track", () => {
    const pred = ri("A", { isPredicted: true });
    const user = ri("A");
    const sel = ri("B", { isSelected: true });
    expect(followTarget([pred, user, sel], "A")).toBe(sel);
    expect(followTarget([pred, user], "A")).toBe(user);
    expect(followTarget([pred], "A")).toBe(pred);
    expect(followTarget([pred], null)).toBeNull();
  });
});
