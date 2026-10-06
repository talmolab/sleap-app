/**
 * Unit tests for `saveLabelsInPlace`'s FALLBACK contract — the two "return
 * {ok:false} so the caller falls back to a full re-save" paths that don't need a
 * Tauri runtime / real HDF5 write:
 *
 *   1. cross-origin isolation unavailable (no SharedArrayBuffer bridge); and
 *   2. the read-only PROBE of the on-disk file fails.
 *
 * The actual in-place write + gate mechanics (checkInPlaceWritable,
 * updateLabelsInPlace) require a real WebView + native file handles and are
 * covered by the io class's own tests (slp-inplace-update.test.ts); here we only
 * assert that `saveLabelsInPlace` degrades to `{ok:false}` (never throws before
 * anything is written) so the caller safely full-re-saves.
 */
import { describe, it, expect, vi } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";

// Mock the native range reader so no real Tauri `invoke` is attempted; the
// probe's very first call is fileSize(), which we make reject to exercise the
// probe-failure fallback deterministically.
const fileSizeMock = vi.fn(async () => {
  throw new Error("no Tauri runtime");
});
vi.mock("@/lib/nativeRange", () => ({
  fileSize: fileSizeMock,
  readRange: vi.fn(),
}));

import { saveLabelsInPlace, frameAnnotationsBlockInPlace } from "@/lib/saveLabelsInPlace";

/** Minimal fake — never dereferenced on the fallback paths (both return before
 *  touching the labels). */
const labels = { videos: [] } as unknown as Labels;

function setCrossOriginIsolated(value: boolean): void {
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value,
    configurable: true,
  });
}

describe("saveLabelsInPlace — fallback contract", () => {
  it("returns {ok:false} (does not throw) when cross-origin isolation is unavailable", async () => {
    setCrossOriginIsolated(false);
    const res = await saveLabelsInPlace(labels, "/whatever.pkg.slp");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cross-origin/i);
    // Bailed before probing anything.
    expect(fileSizeMock).not.toHaveBeenCalled();
  });

  it("returns {ok:false} when the on-disk probe fails (nothing written → safe fall-through)", async () => {
    setCrossOriginIsolated(true); // pass the COI gate so we reach the probe
    const res = await saveLabelsInPlace(labels, "/missing.pkg.slp");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/probe/i);
    expect(fileSizeMock).toHaveBeenCalledTimes(1);
  });
});

describe("saveLabelsInPlace — frame-level annotations force a full re-save", () => {
  // io's in-place writer patches only the label tables; it never touches the
  // /centroids group (or bboxes/masks/rois/label images). An in-place ⌘S of an
  // active-learning project would otherwise silently drop new seeds.
  async function labelsWith(withCentroid: boolean): Promise<Labels> {
    const io = await import("@talmolab/sleap-io.js");
    const video = new io.Video({ filename: "/v.mp4", openBackend: false });
    const lf = new io.LabeledFrame({
      video,
      frameIdx: 0,
      centroids: withCentroid ? [new io.UserCentroid({ x: 1, y: 2 })] : [],
    });
    return new io.Labels({ labeledFrames: [lf], videos: [video] });
  }

  it("refuses in-place when the project has centroids", async () => {
    expect(frameAnnotationsBlockInPlace(await labelsWith(true), { hasCentroids: false })).toMatch(
      /centroid/,
    );
  });

  it("refuses in-place when the file on disk has centroids but memory has none (last one deleted)", async () => {
    expect(frameAnnotationsBlockInPlace(await labelsWith(false), { hasCentroids: true })).toMatch(
      /centroid/,
    );
  });

  it("allows in-place for a plain pose project", async () => {
    expect(frameAnnotationsBlockInPlace(await labelsWith(false), { hasCentroids: false })).toBeNull();
  });
});
