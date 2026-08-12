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
  CONFLICT_BASE_COLOR,
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
  it("colors base blue and donor orange, uniformly, preserving geometry", () => {
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
    // Fixed base/donor colors, not palette/track colors.
    expect(b.every((ri) => ri.color === CONFLICT_BASE_COLOR)).toBe(true);
    expect(d.every((ri) => ri.color === CONFLICT_DONOR_COLOR)).toBe(true);
    // No per-node/edge color overrides that would fight the base/donor color.
    expect(b[0].nodeColors).toBeUndefined();
    expect(b[0].edgeColors).toBeUndefined();
    // Geometry passthrough: 2 nodes, 1 edge.
    expect(b[0].nodes).toHaveLength(2);
    expect(b[0].edges).toHaveLength(1);
    expect(d[0].nodes).toHaveLength(2);
    // Node coordinates preserved (uncropped video → identity image coords).
    expect(b[0].nodes[0].x).toBe(10);
    expect(b[0].nodes[0].y).toBe(10);
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
