/**
 * Unit tests for the pure draft-vs-disk staleness check used by resume: decide
 * whether the on-disk original changed AFTER the draft was saved (another
 * session/tab edited + saved it), which makes the draft stale relative to disk.
 */
import { describe, it, expect } from "../bun-test";
import { isDraftStaleVsDisk, isSourceChanged } from "@/lib/draftStaleness";

describe("isDraftStaleVsDisk", () => {
  it("is false when the disk file predates the draft (normal case)", () => {
    // We opened the file (mtime T0), edited, saved the draft at T1 > T0.
    expect(isDraftStaleVsDisk(/*savedAt*/ 10_000, /*diskMtime*/ 5_000)).toBe(
      false,
    );
  });

  it("is true when the disk file was modified well after the draft was saved", () => {
    // Another session saved the file at T2 >> our draft's savedAt.
    expect(isDraftStaleVsDisk(10_000, 60_000)).toBe(true);
  });

  it("tolerates small clock/mtime jitter within the slack window", () => {
    // Disk mtime a hair after savedAt is not a real external edit.
    expect(isDraftStaleVsDisk(10_000, 11_000)).toBe(false);
  });

  it("flags a divergence just outside the slack window", () => {
    expect(isDraftStaleVsDisk(10_000, 13_000)).toBe(true);
  });

  it("honors an explicit slack override", () => {
    expect(isDraftStaleVsDisk(10_000, 15_000, /*slackMs*/ 10_000)).toBe(false);
    expect(isDraftStaleVsDisk(10_000, 25_000, /*slackMs*/ 10_000)).toBe(true);
  });
});

describe("isSourceChanged", () => {
  it("is false when size AND mtime both match the recorded snapshot", () => {
    expect(
      isSourceChanged(
        { size: 18_120, lastModified: 1_000 },
        { size: 18_120, lastModified: 1_000 },
      ),
    ).toBe(false);
  });

  it("is true when the size differs (real content change)", () => {
    expect(
      isSourceChanged(
        { size: 18_120, lastModified: 1_000 },
        { size: 19_000, lastModified: 1_000 },
      ),
    ).toBe(true);
  });

  it("is true when the mtime differs (e.g. a same-size in-place edit)", () => {
    // A size-preserving external edit still bumps mtime, so it's caught.
    expect(
      isSourceChanged(
        { size: 18_120, lastModified: 1_000 },
        { size: 18_120, lastModified: 2_000 },
      ),
    ).toBe(true);
  });

  it("is false (can't compare) when the snapshot is incomplete — caller falls back", () => {
    expect(
      isSourceChanged({ lastModified: 1_000 }, { size: 18_120, lastModified: 1_000 }),
    ).toBe(false);
    expect(
      isSourceChanged({ size: 18_120 }, { size: 18_120, lastModified: 1_000 }),
    ).toBe(false);
    expect(isSourceChanged({}, { size: 18_120, lastModified: 1_000 })).toBe(false);
  });
});
