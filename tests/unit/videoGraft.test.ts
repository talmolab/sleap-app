/**
 * Unit tests for the pure restore-graft matcher: pairing a draft's videos to the
 * original file's videos by signature (identity), so restore attaches the RIGHT
 * images even if videos were removed/reordered — and leaves unmatched ones blank
 * rather than silently grafting wrong footage.
 */
import { describe, it, expect } from "../bun-test";
import { videoSignature, buildBackendGraftPlan } from "@/lib/videoGraft";

describe("videoSignature", () => {
  it("uses the filename basename + shape (path-independent)", () => {
    expect(
      videoSignature({ filename: "/data/rig/a.mp4", shape: [100, 720, 1280, 1] }),
    ).toBe("a.mp4|100x720x1280x1");
    // Same video, different absolute path → same signature.
    expect(
      videoSignature({ filename: "C:\\other\\a.mp4", shape: [100, 720, 1280, 1] }),
    ).toBe("a.mp4|100x720x1280x1");
  });

  it("distinguishes videos that differ in shape (incl. frame count)", () => {
    expect(videoSignature({ filename: ".", shape: [50, 8, 8, 1] })).not.toBe(
      videoSignature({ filename: ".", shape: [90, 8, 8, 1] }),
    );
  });
});

describe("buildBackendGraftPlan", () => {
  it("maps identical video sets one-to-one by position", () => {
    const sigs = ["a|1", "b|2", "c|3"];
    expect(buildBackendGraftPlan(sigs, sigs)).toEqual([0, 1, 2]);
  });

  it("pairs correctly across a reorder (matches content, not position)", () => {
    // draft [B,C,A] vs original [A,B,C]
    const draft = ["B", "C", "A"];
    const original = ["A", "B", "C"];
    expect(buildBackendGraftPlan(draft, original)).toEqual([1, 2, 0]);
  });

  it("attaches the RIGHT original after a non-last video was removed", () => {
    // draft [B,C] vs original [A,B,C] — B->orig1, C->orig2 (NOT the buggy A,B)
    expect(buildBackendGraftPlan(["B", "C"], ["A", "B", "C"])).toEqual([1, 2]);
  });

  it("returns null for a draft video absent from the original (→ leave blank)", () => {
    // Wrong file picked: no signatures line up.
    expect(buildBackendGraftPlan(["B", "C"], ["X", "Y"])).toEqual([null, null]);
    // Partial: only C is present.
    expect(buildBackendGraftPlan(["B", "C"], ["C", "Z"])).toEqual([null, 0]);
  });

  it("consumes each original at most once for duplicate signatures", () => {
    // Two draft videos with the same signature, only one matching original.
    expect(buildBackendGraftPlan(["d", "d"], ["d", "e"])).toEqual([0, null]);
  });
});
