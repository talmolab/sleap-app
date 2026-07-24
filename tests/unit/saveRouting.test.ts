import { describe, it, expect } from "../bun-test";
import {
  shouldStreamEmbeddedSave,
  shouldOpfsStreamBrowserSave,
  decideBrowserSaveAction,
  STREAMING_SAVE_THRESHOLD_BYTES,
} from "@/lib/saveRouting";

const base = {
  isTauri: true,
  hasEmbeddedImages: true,
  hasSourcePath: true,
  estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES + 1,
};

describe("shouldStreamEmbeddedSave", () => {
  it("does not stream outside Tauri", () => {
    expect(shouldStreamEmbeddedSave({ ...base, isTauri: false })).toBe(false);
  });

  it("does not stream when there are no embedded images", () => {
    expect(
      shouldStreamEmbeddedSave({ ...base, hasEmbeddedImages: false }),
    ).toBe(false);
  });

  it("does not stream without a source path to copy blobs from", () => {
    expect(shouldStreamEmbeddedSave({ ...base, hasSourcePath: false })).toBe(
      false,
    );
  });

  it("uses the in-memory path when the estimate is below the threshold", () => {
    expect(
      shouldStreamEmbeddedSave({
        ...base,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES - 1,
      }),
    ).toBe(false);
  });

  it("does not stream at exactly the threshold (strictly-greater gate)", () => {
    expect(
      shouldStreamEmbeddedSave({
        ...base,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES,
      }),
    ).toBe(false);
  });

  it("streams when the estimate exceeds the threshold", () => {
    expect(
      shouldStreamEmbeddedSave({
        ...base,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES + 1,
      }),
    ).toBe(true);
  });

  it("streams conservatively when the size estimate is unknown (null)", () => {
    expect(
      shouldStreamEmbeddedSave({ ...base, estimatedOutputBytes: null }),
    ).toBe(true);
  });

  it("does not stream on unknown size when it is not an embedded save", () => {
    // The size fallback must not override the eligibility gates.
    expect(
      shouldStreamEmbeddedSave({
        ...base,
        hasEmbeddedImages: false,
        estimatedOutputBytes: null,
      }),
    ).toBe(false);
  });

  it("keeps the threshold conservatively below the ~4 GB wasm wall", () => {
    expect(STREAMING_SAVE_THRESHOLD_BYTES).toBe(3 * 1024 * 1024 * 1024);
    expect(STREAMING_SAVE_THRESHOLD_BYTES).toBeLessThan(4 * 1024 * 1024 * 1024);
  });
});

const browserBase = {
  hasEmbeddedImages: true,
  hasSource: true,
  isOpfsSupported: true,
  estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES + 1,
};

describe("shouldOpfsStreamBrowserSave", () => {
  it("does not stream when there are no embedded images", () => {
    expect(
      shouldOpfsStreamBrowserSave({ ...browserBase, hasEmbeddedImages: false }),
    ).toBe(false);
  });

  it("does not stream without an opened source to copy images from", () => {
    expect(
      shouldOpfsStreamBrowserSave({ ...browserBase, hasSource: false }),
    ).toBe(false);
  });

  it("does not stream when OPFS/showSaveFilePicker is unavailable", () => {
    // No streaming capability => must fall back to the in-memory save.
    expect(
      shouldOpfsStreamBrowserSave({ ...browserBase, isOpfsSupported: false }),
    ).toBe(false);
  });

  it("uses the in-memory path when the estimate is below the threshold", () => {
    expect(
      shouldOpfsStreamBrowserSave({
        ...browserBase,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES - 1,
      }),
    ).toBe(false);
  });

  it("does not stream at exactly the threshold (strictly-greater gate)", () => {
    expect(
      shouldOpfsStreamBrowserSave({
        ...browserBase,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES,
      }),
    ).toBe(false);
  });

  it("streams when the estimate exceeds the threshold", () => {
    expect(
      shouldOpfsStreamBrowserSave({
        ...browserBase,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES + 1,
      }),
    ).toBe(true);
  });

  it("streams conservatively when the size estimate is unknown (null)", () => {
    expect(
      shouldOpfsStreamBrowserSave({ ...browserBase, estimatedOutputBytes: null }),
    ).toBe(true);
  });

  it("does not stream on unknown size when the capability is missing", () => {
    // The size fallback must not override the eligibility gates.
    expect(
      shouldOpfsStreamBrowserSave({
        ...browserBase,
        isOpfsSupported: false,
        estimatedOutputBytes: null,
      }),
    ).toBe(false);
  });
});

const actionBase = {
  hasEmbeddedImages: true,
  hasSource: true,
  isOpfsSupported: true,
  estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES + 1,
  hasWorkingCopy: false,
  forceDialog: false,
};

describe("decideBrowserSaveAction", () => {
  it("uses the in-memory save for a small file with no working copy (⌘S or Save As)", () => {
    const small = STREAMING_SAVE_THRESHOLD_BYTES - 1;
    expect(
      decideBrowserSaveAction({ ...actionBase, estimatedOutputBytes: small }),
    ).toBe("in-memory");
    expect(
      decideBrowserSaveAction({
        ...actionBase,
        estimatedOutputBytes: small,
        forceDialog: true,
      }),
    ).toBe("in-memory");
  });

  it("falls back to the in-memory save when OPFS is unavailable and there's no working copy", () => {
    expect(
      decideBrowserSaveAction({
        ...actionBase,
        isOpfsSupported: false,
        forceDialog: true,
      }),
    ).toBe("in-memory");
  });

  it("SEEDS a working copy on the first ⌘S of a large embedded pkg (no working copy yet)", () => {
    expect(decideBrowserSaveAction(actionBase)).toBe("seed-working-copy");
  });

  it("streams a full file to disk on Save As of a large pkg with no working copy", () => {
    expect(
      decideBrowserSaveAction({ ...actionBase, forceDialog: true }),
    ).toBe("opfs-stream");
  });

  it("COMMITS to an existing working copy on ⌘S, regardless of size/source/OPFS", () => {
    // A working copy is self-contained and authoritative: commit even if the
    // original source is gone, the estimate is small, or OPFS looks unsupported
    // (it can't be — a copy could only exist if OPFS worked to create it).
    expect(
      decideBrowserSaveAction({ ...actionBase, hasWorkingCopy: true }),
    ).toBe("commit-working-copy");
    expect(
      decideBrowserSaveAction({
        ...actionBase,
        hasWorkingCopy: true,
        hasSource: false,
        estimatedOutputBytes: STREAMING_SAVE_THRESHOLD_BYTES - 1,
      }),
    ).toBe("commit-working-copy");
  });

  it("EXPORTS an existing working copy to disk on Save As", () => {
    expect(
      decideBrowserSaveAction({
        ...actionBase,
        hasWorkingCopy: true,
        forceDialog: true,
      }),
    ).toBe("export-working-copy");
  });
});
