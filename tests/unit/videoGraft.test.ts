/**
 * Unit tests for the pure restore-graft matcher: pairing a draft's videos to the
 * original file's videos by signature (identity), so restore attaches the RIGHT
 * images even if videos were removed/reordered — and leaves unmatched ones blank
 * rather than silently grafting wrong footage.
 */
import { describe, it, expect } from "../bun-test";
import {
  videoSignature,
  buildBackendGraftPlan,
  frameIndexDigest,
} from "@/lib/videoGraft";

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

  it("is container-independent for EMBEDDED videos (shape-only)", () => {
    // Embedded pkg videos have no stored filename; sleap-io resolves
    // `Video.filename` to the CONTAINING `.slp` file. So the same embedded video
    // reports the pkg path on a fresh open but the OPFS draft path after a restore
    // — and the call sites pass NO explicit flag, only `{filename, shape}`. Its
    // signature MUST NOT depend on that container path, or a post-restore ⌘S
    // records draft-prefixed signatures that can't match the re-opened original
    // and restore aborts with "none of the draft's videos were found". A `.slp`
    // filename is the tell that it's a container, not a real per-video name.
    const fromPkg = videoSignature({
      filename: "train copy.pkg.slp",
      shape: [7632, 480, 640, 3],
    });
    const fromDraft = videoSignature({
      filename: "sleap-draft-train-copy.pkg-ms56dsn6-ea453b5a.slp",
      shape: [7632, 480, 640, 3],
    });
    expect(fromPkg).toBe(fromDraft);
    // An explicit `embedded: true` flag also forces shape-only, for callers that
    // know a video is embedded regardless of its filename.
    expect(
      videoSignature({ filename: "x.mp4", shape: [7632, 480, 640, 3], embedded: true }),
    ).toBe(
      videoSignature({ filename: "y.mp4", shape: [7632, 480, 640, 3], embedded: true }),
    );
  });

  it("still uses filename basename + shape for NON-embedded videos", () => {
    // External MediaVideo: the filename is a real, stable video path — keep it so
    // reorder/wrong-file detection still works for these formats.
    expect(
      videoSignature({ filename: "/data/a.mp4", shape: [100, 720, 1280, 1], embedded: false }),
    ).toBe("a.mp4|100x720x1280x1");
    // `embedded` omitted (or false) behaves exactly as before (back-compat).
    expect(
      videoSignature({ filename: "/data/a.mp4", shape: [100, 720, 1280, 1] }),
    ).toBe("a.mp4|100x720x1280x1");
    // Image sequence: filename is a string[] (first frame's basename).
    expect(
      videoSignature({ filename: ["/imgs/frame0.png"], shape: [10, 8, 8, 3], embedded: false }),
    ).toBe("frame0.png|10x8x8x3");
  });
});

describe("videoSignature frame-index hardening (#245)", () => {
  const SHAPE = [100, 8, 8, 1];

  it("distinguishes same-shape EMBEDDED videos with DIFFERENT embedded frames", () => {
    // The real risk: a wrong file with identical dimensions used to sign the same
    // (shape-only) and graft silently. Keying on the embedded frame-index SET makes
    // the two videos sign differently.
    const a = videoSignature({
      filename: "pkg.slp",
      shape: SHAPE,
      embedded: true,
      embeddedFrameIndices: [0, 5, 10],
    });
    const b = videoSignature({
      filename: "pkg.slp",
      shape: SHAPE,
      embedded: true,
      embeddedFrameIndices: [1, 6, 11],
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes same-shape embedded videos with a DIFFERENT frame COUNT", () => {
    expect(
      videoSignature({
        filename: "pkg.slp",
        shape: SHAPE,
        embedded: true,
        embeddedFrameIndices: [0, 1, 2],
      }),
    ).not.toBe(
      videoSignature({
        filename: "pkg.slp",
        shape: SHAPE,
        embedded: true,
        embeddedFrameIndices: [0, 1, 2, 3],
      }),
    );
  });

  it("gives IDENTICAL frame sets the SAME signature (container-independent)", () => {
    // Same embedded frames signed from the pkg vs. the OPFS draft container must
    // still round-trip identically (the property that makes restore work).
    const fromPkg = videoSignature({
      filename: "train copy.pkg.slp",
      shape: SHAPE,
      embeddedFrameIndices: [0, 5, 10],
    });
    const fromDraft = videoSignature({
      filename: "sleap-draft-x.slp",
      shape: SHAPE,
      embeddedFrameIndices: [0, 5, 10],
    });
    expect(fromPkg).toBe(fromDraft);
  });

  it("falls back to shape-only for an embedded video with NO frame indices (back-compat)", () => {
    // Lazy/deferred backends (large pkg not yet viewed) expose no frame numbers →
    // null indices → the signature MUST equal the old shape-only form so a new
    // signer still matches an old-manifest / lazily-loaded counterpart.
    const withNone = videoSignature({
      filename: "pkg.slp",
      shape: SHAPE,
      embedded: true,
    });
    const withNull = videoSignature({
      filename: "other.slp",
      shape: SHAPE,
      embedded: true,
      embeddedFrameIndices: null,
    });
    expect(withNone).toBe("|100x8x8x1");
    expect(withNull).toBe("|100x8x8x1");
  });

  it("ignores embeddedFrameIndices for EXTERNAL videos (unchanged name+shape)", () => {
    expect(
      videoSignature({
        filename: "/data/a.mp4",
        shape: SHAPE,
        embedded: false,
        embeddedFrameIndices: [0, 1, 2],
      }),
    ).toBe("a.mp4|100x8x8x1");
  });

  it("adds a REAL source-name hint but ignores '.' / .slp container provenance", () => {
    const base = videoSignature({
      filename: "pkg.slp",
      shape: [10, 8, 8, 1],
      embedded: true,
      embeddedFrameIndices: [0, 1],
    });
    // A real source filename is a (secondary) discriminator → changes the sig.
    expect(
      videoSignature({
        filename: "pkg.slp",
        shape: [10, 8, 8, 1],
        embedded: true,
        embeddedFrameIndices: [0, 1],
        sourceName: "/rig/real.mp4",
      }),
    ).not.toBe(base);
    // "." resolves to the container path (unreliable) → treated as absent.
    expect(
      videoSignature({
        filename: "pkg.slp",
        shape: [10, 8, 8, 1],
        embedded: true,
        embeddedFrameIndices: [0, 1],
        sourceName: ".",
      }),
    ).toBe(base);
    // A `.slp` container is never a real per-video source name → treated as absent.
    expect(
      videoSignature({
        filename: "pkg.slp",
        shape: [10, 8, 8, 1],
        embedded: true,
        embeddedFrameIndices: [0, 1],
        sourceName: "train.pkg.slp",
      }),
    ).toBe(base);
  });

  it("frameIndexDigest: stable for equal sets, differs on any change, null when empty", () => {
    expect(frameIndexDigest([0, 5, 10])).toBe(frameIndexDigest([0, 5, 10]));
    expect(frameIndexDigest([0, 5, 10])).not.toBe(frameIndexDigest([0, 5, 11]));
    expect(frameIndexDigest([0, 5, 10])).not.toBe(frameIndexDigest([0, 5]));
    expect(frameIndexDigest([])).toBeNull();
    expect(frameIndexDigest(null)).toBeNull();
  });
});

describe("buildBackendGraftPlan digest veto (#245)", () => {
  const SHAPE = [100, 8, 8, 1];
  const emb = (indices: number[] | null, sourceName?: string) =>
    videoSignature({
      filename: "pkg.slp",
      shape: SHAPE,
      embedded: true,
      embeddedFrameIndices: indices,
      sourceName,
    });

  it("REFUSES a wrong-but-same-shape re-pick that shape alone would graft", () => {
    // Same shapes, same order → the shape-only base grafts positionally. But the
    // embedded frame sets differ (different footage), so the digest veto blocks it.
    const draft = [emb([0, 5, 10]), emb([2, 7, 12])];
    const wrong = [emb([1, 3, 4]), emb([6, 7, 8])];
    expect(buildBackendGraftPlan(draft, wrong)).toEqual([null, null]);
  });

  it("still grafts the CORRECT file positionally (same shapes, same frames)", () => {
    const draft = [emb([0, 5, 10]), emb([2, 7, 12])];
    expect(buildBackendGraftPlan(draft, draft.slice())).toEqual([0, 1]);
  });

  it("does NOT regress when the original lacks a digest (lazy/deferred backend)", () => {
    // Asymmetry: the draft was signed with frame indices, but the re-opened
    // original is lazy (no frame numbers yet). A missing digest is a wildcard, so
    // the correct file still grafts.
    const draft = [emb([0, 5, 10]), emb([2, 7, 12])];
    const lazyOriginal = [emb(null), emb(null)];
    expect(buildBackendGraftPlan(draft, lazyOriginal)).toEqual([0, 1]);
  });

  it("vetoes on a conflicting source name even without frame digests", () => {
    const draft = [emb(null, "/a/cam0.mp4"), emb(null, "/a/cam1.mp4")];
    const wrong = [emb(null, "/x/cam9.mp4"), emb(null, "/x/cam8.mp4")];
    expect(buildBackendGraftPlan(draft, wrong)).toEqual([null, null]);
  });

  it("a matching source name cannot RESCUE a shape (base) mismatch", () => {
    const d = videoSignature({
      filename: "pkg.slp",
      shape: [10, 8, 8, 1],
      embedded: true,
      sourceName: "/a/x.mp4",
    });
    const o = videoSignature({
      filename: "pkg.slp",
      shape: [20, 8, 8, 1],
      embedded: true,
      sourceName: "/a/x.mp4",
    });
    expect(buildBackendGraftPlan([d], [o])).toEqual([null]);
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

  it("matches EMBEDDED videos across a restore despite the container filename change", () => {
    // End-to-end reproduction of the reported bug: after a restore, a subsequent
    // ⌘S records signatures whose filename is the OPFS draft path; the next restore
    // compares them to the re-opened original (the pkg path). With embedded videos
    // signed shape-only, the two sets are identical and graft 1:1 by position.
    const shapes = [
      [7632, 480, 640, 3],
      [8397, 480, 640, 3],
      [9704, 240, 320, 3],
    ];
    const draftSigs = shapes.map((s) =>
      videoSignature({ filename: "sleap-draft-x.slp", shape: s }),
    );
    const originalSigs = shapes.map((s) =>
      videoSignature({ filename: "train copy.pkg.slp", shape: s }),
    );
    expect(buildBackendGraftPlan(draftSigs, originalSigs)).toEqual([0, 1, 2]);
  });
});
