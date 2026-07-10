import { describe, it, expect } from "../bun-test";
import { renderInstances, type RenderedInstance } from "@/canvas/SkeletonRenderer";

/** Minimal CanvasRenderingContext2D spy — counts arc() calls (one per drawn node). */
function mockCtx() {
  const calls = { arc: 0, beginPath: 0 };
  return new Proxy(
    {
      arc: () => { calls.arc++; },
      beginPath: () => { calls.beginPath++; },
    },
    {
      get(target, prop) {
        if (prop === "__calls") return calls;
        if (prop in target) return (target as Record<string, unknown>)[prop as string];
        return () => {}; // no-op for every other ctx method/prop
      },
      set: () => true, // swallow fillStyle/strokeStyle/etc.
    },
  ) as unknown as CanvasRenderingContext2D & { __calls: typeof calls };
}

function inst(over: Partial<RenderedInstance>): RenderedInstance {
  return {
    nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
    ...over,
  };
}

describe("renderInstances per-instance flags", () => {
  it("skips instances with visible=false", () => {
    const ctx = mockCtx();
    renderInstances(ctx, [inst({ visible: false })], { showInstances: true });
    expect((ctx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(0);
  });

  it("draws an occluded node only when that instance's showNonVisible is true", () => {
    const occluded = inst({
      nodes: [{ x: 1, y: 1, visible: false, complete: false, name: "n" }],
    });
    const onCtx = mockCtx();
    renderInstances(onCtx, [{ ...occluded, showNonVisible: true }], { showInstances: true });
    expect((onCtx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(1);

    const offCtx = mockCtx();
    renderInstances(offCtx, [{ ...occluded, showNonVisible: false }], { showInstances: true });
    expect((offCtx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(0);
  });
});
