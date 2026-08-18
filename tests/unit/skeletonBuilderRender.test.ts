import { describe, it, expect } from "../bun-test";
import { Skeleton } from "@talmolab/sleap-io.js";
import { buildBuilderRenderedInstance } from "@/canvas/skeletonBuilderRender";

function makeSkeleton(): Skeleton {
  return new Skeleton({
    nodes: ["a", "b", "c"],
    edges: [
      ["a", "b"],
      ["b", "c"],
    ],
  });
}

describe("buildBuilderRenderedInstance", () => {
  it("maps one RenderedNode per skeleton node, with names in order", () => {
    const skeleton = makeSkeleton();
    const inst = buildBuilderRenderedInstance(skeleton, [
      { x: 10, y: 20 },
      null,
      { x: 30, y: 40 },
    ]);

    expect(inst.nodes.length).toBe(3);
    expect(inst.nodes.map((n) => n.name)).toEqual(["a", "b", "c"]);
  });

  it("gives a placed position finite x/y and visible:true", () => {
    const skeleton = makeSkeleton();
    const inst = buildBuilderRenderedInstance(skeleton, [
      { x: 10, y: 20 },
      null,
      { x: 30, y: 40 },
    ]);

    expect(inst.nodes[0].x).toBe(10);
    expect(inst.nodes[0].y).toBe(20);
    expect(Number.isFinite(inst.nodes[0].x)).toBe(true);
    expect(Number.isFinite(inst.nodes[0].y)).toBe(true);
    expect(inst.nodes[0].visible).toBe(true);

    expect(inst.nodes[2].x).toBe(30);
    expect(inst.nodes[2].y).toBe(40);
    expect(inst.nodes[2].visible).toBe(true);
  });

  it("maps a null/missing position to NaN x/y and visible:false", () => {
    const skeleton = makeSkeleton();
    // Third slot omitted entirely (missing, not just null).
    const inst = buildBuilderRenderedInstance(skeleton, [
      { x: 10, y: 20 },
      null,
    ]);

    // null slot -> unplaced
    expect(Number.isNaN(inst.nodes[1].x)).toBe(true);
    expect(Number.isNaN(inst.nodes[1].y)).toBe(true);
    expect(inst.nodes[1].visible).toBe(false);

    // missing slot -> unplaced
    expect(Number.isNaN(inst.nodes[2].x)).toBe(true);
    expect(Number.isNaN(inst.nodes[2].y)).toBe(true);
    expect(inst.nodes[2].visible).toBe(false);
  });

  it("maps each skeleton edge to a RenderedEdge with correct endpoint indices", () => {
    const skeleton = makeSkeleton();
    const inst = buildBuilderRenderedInstance(skeleton, [
      { x: 10, y: 20 },
      { x: 15, y: 25 },
      { x: 30, y: 40 },
    ]);

    expect(inst.edges.length).toBe(2);
    expect(inst.edges[0]).toEqual({ srcIdx: 0, dstIdx: 1 });
    expect(inst.edges[1]).toEqual({ srcIdx: 1, dstIdx: 2 });
  });

  it("sets builder instance flags for a scratch (non-labeled) instance", () => {
    const skeleton = makeSkeleton();
    const inst = buildBuilderRenderedInstance(skeleton, []);

    expect(inst.isPredicted).toBe(false);
    expect(inst.isSelected).toBe(false);
    expect(inst.trackName).toBe(null);
    expect(inst.visible).toBe(true);
    expect(inst.showNonVisible).toBe(true);
    // has a default color triple
    expect(Array.isArray(inst.color)).toBe(true);
    expect(inst.color.length).toBe(3);
  });

  it("accepts an optional builder color override", () => {
    const skeleton = makeSkeleton();
    const color: [number, number, number] = [1, 2, 3];
    const inst = buildBuilderRenderedInstance(skeleton, [], { color });
    expect(inst.color).toEqual([1, 2, 3]);
  });
});
