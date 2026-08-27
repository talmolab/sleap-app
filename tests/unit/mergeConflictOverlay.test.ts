/**
 * Unit tests for the merge-conflict preview overlay builder.
 *
 * The conflict preview canvas draws the BASE pose and the DONOR pose for one
 * clashing frame in two fixed colors (blue vs orange) so the user can eyeball
 * which to keep. `buildConflictOverlay` reuses the clip-exporter's pure
 * `buildExportRenderedInstances` (crop-aware node coords, edges) but overrides
 * the per-instance color to the fixed base/donor colors. This tests only that
 * color-forcing + geometry passthrough — the actual canvas paint is verified
 * visually (Playwright).
 */

import { describe, it, expect } from "../bun-test";
import {
  buildConflictOverlay,
  computeFitTransform,
  conflictCropRect,
  CONFLICT_DONOR_COLOR,
} from "@/lib/mergeConflictOverlay";
import { Instance, Skeleton, Video } from "@talmolab/sleap-io.js";

function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["head", "tail"], name: "s" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}

function makeVideo(): Video {
  return new Video({
    filename: "/v/clip.mp4",
    backendMetadata: { shape: [10, 100, 100, 1] },
    openBackend: false,
  });
}

function inst(sk: Skeleton, x: number, y: number): Instance {
  return Instance.fromArray(
    [
      [x, y],
      [x + 5, y + 5],
    ],
    sk
  );
}

describe("buildConflictOverlay", () => {
  it("keeps base's computed color, forces the donor color, preserves geometry", () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const base = [inst(sk, 10, 10)];
    const donor = [inst(sk, 12, 12), inst(sk, 40, 40)];

    const { base: b, donor: d } = buildConflictOverlay(base, donor, {
      video,
      tracks: [],
    });

    expect(b).toHaveLength(1);
    expect(d).toHaveLength(2);
    // Donor is recolored to the fixed donor color; base keeps its computed
    // (track/palette) color so it matches the on-canvas instance.
    expect(d.every((ri) => ri.color === CONFLICT_DONOR_COLOR)).toBe(true);
    expect(b.every((ri) => ri.color !== CONFLICT_DONOR_COLOR)).toBe(true);
    expect(Array.isArray(b[0].color)).toBe(true);
    expect(b[0].color).toHaveLength(3); // an RGB tuple
    // Donor color is uniform (no per-node/edge overrides).
    expect(d[0].nodeColors).toBeUndefined();
    expect(d[0].edgeColors).toBeUndefined();
    // Geometry passthrough: 2 nodes, 1 edge.
    expect(b[0].nodes).toHaveLength(2);
    expect(b[0].edges).toHaveLength(1);
    expect(d[0].nodes).toHaveLength(2);
    // Node coordinates preserved (uncropped video → identity image coords).
    expect(b[0].nodes[0].x).toBe(10);
    expect(b[0].nodes[0].y).toBe(10);
  });

  it("gives multiple untracked base instances distinct evenly-spaced grays", () => {
    const sk = makeSkeleton();
    const video = makeVideo();
    const { base } = buildConflictOverlay(
      [inst(sk, 10, 10), inst(sk, 20, 20), inst(sk, 30, 30)],
      [],
      { video, tracks: [] }
    );
    expect(base).toHaveLength(3);
    const colors = base.map((ri) => ri.color);
    // Grayscale (R === G === B) for every untracked instance...
    for (const c of colors) {
      expect(c[0]).toBe(c[1]);
      expect(c[1]).toBe(c[2]);
    }
    // ...but distinct from one another, not all collapsed to one gray.
    expect(new Set(colors.map((c) => c.join(","))).size).toBe(3);
  });

  it("returns empty arrays for empty inputs", () => {
    const { base, donor } = buildConflictOverlay([], [], {
      video: makeVideo(),
      tracks: [],
    });
    expect(base).toEqual([]);
    expect(donor).toEqual([]);
  });
});

describe("computeFitTransform", () => {
  it("scales up and centers a square frame in a square canvas", () => {
    const t = computeFitTransform(100, 100, 300, 300);
    expect(t.scale).toBe(3);
    expect(t.displayWidth).toBe(300);
    expect(t.displayHeight).toBe(300);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBe(0);
  });

  it("letterboxes a wide frame (fits width, centers vertically)", () => {
    const t = computeFitTransform(200, 100, 300, 300);
    expect(t.scale).toBe(1.5); // min(300/200, 300/100) = 1.5
    expect(t.displayWidth).toBe(300);
    expect(t.displayHeight).toBe(150);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBe(75); // (300 - 150) / 2
  });

  it("is safe for a zero-sized source", () => {
    const t = computeFitTransform(0, 0, 300, 300);
    expect(t.displayWidth).toBe(0);
    expect(t.displayHeight).toBe(0);
  });
});

describe("conflictCropRect", () => {
  it("returns the tight bbox of visible nodes with no pad/min", () => {
    const rect = conflictCropRect(
      [{ nodes: [{ x: 10, y: 10, visible: true }, { x: 20, y: 20, visible: true }] }],
      { padFrac: 0, minSize: 0 }
    );
    expect(rect).toEqual({ x: 10, y: 10, w: 10, h: 10 });
  });

  it("enforces a minimum size around a single point (centered)", () => {
    const rect = conflictCropRect([{ nodes: [{ x: 100, y: 100, visible: true }] }], {
      padFrac: 0,
      minSize: 40,
    });
    expect(rect).toEqual({ x: 80, y: 80, w: 40, h: 40 });
  });

  it("pads the bbox by padFrac", () => {
    const rect = conflictCropRect(
      [{ nodes: [{ x: 0, y: 0, visible: true }, { x: 10, y: 0, visible: true }] }],
      { padFrac: 1, minSize: 0 }
    );
    // width 10 → padded to 20, centered at x=5 → x=-5..15; height 0 → 0.
    expect(rect?.w).toBe(20);
    expect(rect?.x).toBe(-5);
  });

  it("returns null when there are no visible, finite nodes", () => {
    expect(conflictCropRect([{ nodes: [{ x: 1, y: 1, visible: false }] }])).toBeNull();
    expect(
      conflictCropRect([{ nodes: [{ x: NaN, y: NaN, visible: true }] }])
    ).toBeNull();
  });
});
