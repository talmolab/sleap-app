/**
 * Legacy SLEAP's pre-run training checks (`LearningDialog._validate_pipeline`):
 * bottom-up needs a skeleton that is a tree with one root, and ID models need
 * tracked user instances.
 */

import { describe, it, expect } from "../bun-test";
import {
  arborescenceMessage,
  arborescenceProblems,
  hasTrackedUserInstances,
} from "@/lib/trainingChecks";

function skel(nodes: string[], edges: [string, string][]) {
  return {
    nodes: nodes.map((name) => ({ name })),
    edges: edges.map(([s, d]) => ({ source: { name: s }, destination: { name: d } })),
  };
}

describe("arborescenceProblems", () => {
  it("accepts a tree with one root", () => {
    expect(arborescenceProblems(skel(["head", "thorax", "l", "r"], [["head", "thorax"], ["thorax", "l"], ["thorax", "r"]]))).toBeNull();
  });

  it("accepts a single node", () => {
    expect(arborescenceProblems(skel(["a"], []))).toBeNull();
  });

  it("reports several roots for a disconnected skeleton", () => {
    const p = arborescenceProblems(skel(["a", "b", "c", "d"], [["a", "b"], ["c", "d"]]));
    expect(p?.roots).toEqual(["a", "c"]);
    expect(p?.multiParent).toEqual([]);
    expect(p?.cycles).toEqual([]);
  });

  it("reports a node with two parents", () => {
    const p = arborescenceProblems(skel(["a", "b", "c"], [["a", "c"], ["b", "c"]]));
    expect(p?.multiParent).toEqual(["c"]);
    expect(p?.roots).toEqual(["a", "b"]);
  });

  it("reports a cycle with no root", () => {
    const p = arborescenceProblems(skel(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]));
    expect(p?.cycles).toEqual([["a", "b", "c", "a"]]);
    expect(p?.roots).toEqual([]);
  });

  it("reports a cycle hanging off a root", () => {
    const p = arborescenceProblems(skel(["r", "a", "b"], [["r", "a"], ["a", "b"], ["b", "a"]]));
    expect(p?.cycles).toEqual([["a", "b", "a"]]);
    expect(p?.multiParent).toEqual(["a"]);
  });

  it("reports a self-loop", () => {
    const p = arborescenceProblems(skel(["a", "b"], [["a", "b"], ["b", "b"]]));
    expect(p?.cycles).toEqual([["b", "b"]]);
  });
});

describe("arborescenceMessage", () => {
  it("names every problem", () => {
    const msg = arborescenceMessage({ roots: ["a", "c"], multiParent: ["d"], cycles: [["x", "y", "x"]] });
    expect(msg).toContain("tree with one root");
    expect(msg).toContain("a, c");
    expect(msg).toContain("more than one edge: d");
    expect(msg).toContain("x → y → x");
  });
});

describe("hasTrackedUserInstances", () => {
  const track = { name: "t" };
  it("is false with no tracks", () => {
    expect(hasTrackedUserInstances({ tracks: [], labeledFrames: [{ userInstances: [{ track: null }] }] })).toBe(false);
  });

  it("is false when tracks exist but no user instance has one", () => {
    // e.g. tracked predictions only: they aren't training data.
    expect(hasTrackedUserInstances({ tracks: [track], labeledFrames: [{ userInstances: [{ track: null }] }] })).toBe(false);
  });

  it("is true when a user instance has a track", () => {
    expect(
      hasTrackedUserInstances({ tracks: [track], labeledFrames: [{ userInstances: [] }, { userInstances: [{ track }] }] })
    ).toBe(true);
  });

  it("is false with no labels", () => {
    expect(hasTrackedUserInstances(null)).toBe(false);
  });
});
