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

  it("grafts positionally when the sets are identical, even with duplicate signatures", () => {
    // Same videos, same order (the common resume case): a 1:1 positional graft is
    // exact even when several videos share a signature (e.g. same-shape embedded
    // videos, whose signature collapses to `.|<shape>`).
    const sigs = ["d", "d", "e"];
    expect(buildBackendGraftPlan(sigs, sigs)).toEqual([0, 1, 2]);
  });

  it("refuses ambiguous duplicate-signature matches once the set diverged", () => {
    // draft [d,d] (a video was removed) vs original [d,d,d]: the two draft videos
    // are indistinguishable, so a positional guess could attach the WRONG footage.
    // Refuse both (→ blank frames + a warning) rather than risk a silent mis-graft.
    expect(buildBackendGraftPlan(["d", "d"], ["d", "d", "d"])).toEqual([
      null,
      null,
    ]);
    // Duplicate on the draft side with a single original match: still ambiguous
    // (which draft 'd' is the real one?), so refuse rather than guess.
    expect(buildBackendGraftPlan(["d", "d"], ["d", "e"])).toEqual([null, null]);
  });

  it("still matches globally-unique signatures under divergence", () => {
    // Unique signatures are unambiguous regardless of order/removal, so they graft
    // even when other (duplicate) videos in the set can't be resolved.
    expect(buildBackendGraftPlan(["u", "d", "d"], ["d", "d", "u"])).toEqual([
      2,
      null,
      null,
    ]);
  });
});
