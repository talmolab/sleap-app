/**
 * Tests for the pure edge-selection helpers used by the Skeleton panel's
 * "Add Edge" dialog (auto-fill / auto-advance source->destination). See #158.
 *
 * These cover the React-free logic in src/lib/skeletonEdgeEditing.ts only;
 * wiring into SkeletonPanel.tsx is tested separately.
 */

import { describe, it, expect } from "../bun-test";
import {
  validDestinationNames,
  firstValidDestination,
  initialEdgeSelection,
  nextEdgeSelection,
  isValidEdgeSelection,
  type NodeLike,
  type EdgeLike,
} from "@/lib/skeletonEdgeEditing";

/** Build node-like objects from a list of names. */
function nodes(...names: string[]): NodeLike[] {
  return names.map((name) => ({ name }));
}

/** Build a directed edge-like object src -> dst. */
function edge(src: string, dst: string): EdgeLike {
  return { source: { name: src }, destination: { name: dst } };
}

describe("validDestinationNames", () => {
  it("excludes the source node itself", () => {
    const ns = nodes("a", "b", "c");
    expect(validDestinationNames(ns, "a", [])).toEqual(["b", "c"]);
  });

  it("returns names in nodes order", () => {
    const ns = nodes("c", "a", "b");
    expect(validDestinationNames(ns, "c", [])).toEqual(["a", "b"]);
  });

  it("excludes destinations already connected from that source", () => {
    const ns = nodes("a", "b", "c", "d");
    const edges = [edge("a", "b")];
    expect(validDestinationNames(ns, "a", edges)).toEqual(["c", "d"]);
  });

  it("does NOT exclude destinations of a different source", () => {
    const ns = nodes("a", "b", "c", "d");
    // b->c exists, but for source "a" that must not remove "c".
    const edges = [edge("b", "c")];
    expect(validDestinationNames(ns, "a", edges)).toEqual(["b", "c", "d"]);
  });

  it("returns [] when every other node is already a destination of the source", () => {
    const ns = nodes("a", "b", "c");
    const edges = [edge("a", "b"), edge("a", "c")];
    expect(validDestinationNames(ns, "a", edges)).toEqual([]);
  });

  it("returns all node names when srcName is empty", () => {
    const ns = nodes("a", "b", "c");
    expect(validDestinationNames(ns, "", [edge("a", "b")])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not collide on node names containing spaces", () => {
    // Node names are free text with internal spaces. The ("a" -> "b c") edge
    // must NOT be confused with ("a b" -> "c") via a single-space join key.
    const ns = nodes("a b", "a", "b c", "c");
    const edges = [edge("a", "b c")];
    // Valid dsts for source "a b": exclude itself only; "c" must remain.
    expect(validDestinationNames(ns, "a b", edges)).toEqual(["a", "b c", "c"]);
  });
});

describe("firstValidDestination", () => {
  it("returns the first valid destination name", () => {
    const ns = nodes("a", "b", "c");
    expect(firstValidDestination(ns, "a", [edge("a", "b")])).toBe("c");
  });

  it('returns "" when there is no valid destination', () => {
    const ns = nodes("a", "b");
    expect(firstValidDestination(ns, "a", [edge("a", "b")])).toBe("");
  });
});

describe("initialEdgeSelection", () => {
  it("defaults src to nodes[0] and dst to the first valid destination", () => {
    const ns = nodes("a", "b", "c");
    expect(initialEdgeSelection(ns, [])).toEqual({ src: "a", dst: "b" });
  });

  it("skips an already-connected destination when picking dst", () => {
    const ns = nodes("a", "b", "c");
    expect(initialEdgeSelection(ns, [edge("a", "b")])).toEqual({
      src: "a",
      dst: "c",
    });
  });

  it("honors a valid preferredSrc", () => {
    const ns = nodes("a", "b", "c");
    expect(initialEdgeSelection(ns, [], "b")).toEqual({ src: "b", dst: "a" });
  });

  it("falls back to nodes[0] when preferredSrc is not a node", () => {
    const ns = nodes("a", "b", "c");
    expect(initialEdgeSelection(ns, [], "zzz")).toEqual({ src: "a", dst: "b" });
  });

  it('returns empty src/dst when there are no nodes', () => {
    expect(initialEdgeSelection([], [])).toEqual({ src: "", dst: "" });
  });
});

describe("nextEdgeSelection", () => {
  it("advances src to justAddedDst and dst to the next valid destination", () => {
    const ns = nodes("a", "b", "c");
    // Caller passes POST-add edges: a->b was just added.
    const edges = [edge("a", "b")];
    // src becomes "b"; valid dsts of "b" are a, c -> first is "a".
    expect(nextEdgeSelection(ns, edges, "b")).toEqual({ src: "b", dst: "a" });
  });

  it("respects edges already incident on the new source", () => {
    const ns = nodes("a", "b", "c");
    // a->b just added; b->a already existed -> next dst for src "b" is "c".
    const edges = [edge("b", "a"), edge("a", "b")];
    expect(nextEdgeSelection(ns, edges, "b")).toEqual({ src: "b", dst: "c" });
  });

  it("falls back to nodes[0] when justAddedDst is no longer a node", () => {
    const ns = nodes("a", "b", "c");
    expect(nextEdgeSelection(ns, [edge("a", "b")], "gone")).toEqual({
      src: "a",
      dst: "c",
    });
  });
});

describe("isValidEdgeSelection", () => {
  it("accepts a fresh valid pair", () => {
    const ns = nodes("a", "b", "c");
    expect(isValidEdgeSelection(ns, [], "a", "b")).toBe(true);
  });

  it("rejects a self-edge", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [], "a", "a")).toBe(false);
  });

  it("rejects a duplicate edge", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [edge("a", "b")], "a", "b")).toBe(false);
  });

  it("accepts the reverse of an existing edge (direction matters)", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [edge("a", "b")], "b", "a")).toBe(true);
  });

  it("rejects an unknown source node", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [], "zzz", "b")).toBe(false);
  });

  it("rejects an unknown destination node", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [], "a", "zzz")).toBe(false);
  });

  it("rejects empty src or dst", () => {
    const ns = nodes("a", "b");
    expect(isValidEdgeSelection(ns, [], "", "b")).toBe(false);
    expect(isValidEdgeSelection(ns, [], "a", "")).toBe(false);
  });

  it("does not collide on node names containing spaces", () => {
    // ("a" -> "b c") exists; ("a b" -> "c") is a distinct, valid new edge and
    // must not be rejected as a duplicate via a single-space join key.
    const ns = nodes("a b", "a", "b c", "c");
    const edges = [edge("a", "b c")];
    expect(isValidEdgeSelection(ns, edges, "a b", "c")).toBe(true);
  });
});
