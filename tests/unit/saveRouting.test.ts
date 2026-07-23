import { describe, it, expect } from "../bun-test";
import {
  shouldStreamEmbeddedSave,
  shouldOpfsStreamBrowserSave,
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
