/**
 * The package frame format (#512): the remembered preference in the app store
 * (defaults, setter, and a corrupt stored value), and the compatibility
 * helpers against the installed sleap-io.js. A release without
 * `imageFormat` (the pinned 0.5.16) can't write JPEG: the choice is refused
 * before anything is written. One with it gets `imageFormat: "jpg"` and
 * `imageQuality`. PNG adds nothing on either.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import * as sio from "@talmolab/sleap-io.js";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";
import {
  DEFAULT_PACKAGE_IMAGE,
  clampJpegQuality,
  isJpegChoice,
  normalizePackageImage,
} from "@/lib/packageImageFormat";
import {
  canWriteJpegFrames,
  withImageFormat,
  JPEG_FRAMES_UNAVAILABLE,
} from "@/lib/slpFormatCompat";

/** Does the installed sleap-io.js list JPEG among its embed formats? */
const LIBRARY_HAS_JPEG = (
  (sio as unknown as { EMBED_IMAGE_FORMATS?: readonly string[] }).EMBED_IMAGE_FORMATS ?? []
).includes("jpg");

describe("packageImageFormat", () => {
  it("defaults to PNG, with JPEG quality 95", () => {
    expect(DEFAULT_PACKAGE_IMAGE).toEqual({ format: "png", quality: 95 });
    expect(isJpegChoice(DEFAULT_PACKAGE_IMAGE)).toBe(false);
    expect(isJpegChoice({ format: "jpg", quality: 1 })).toBe(true);
    expect(isJpegChoice(undefined)).toBe(false);
  });

  it("reads unknown formats as PNG and clamps the quality to 1-100", () => {
    expect(normalizePackageImage("jpg", 80)).toEqual({ format: "jpg", quality: 80 });
    expect(normalizePackageImage("jpeg", 80).format).toBe("png");
    expect(normalizePackageImage(undefined, undefined)).toEqual({ format: "png", quality: 95 });
    expect(clampJpegQuality(0)).toBe(1);
    expect(clampJpegQuality(150)).toBe(100);
    expect(clampJpegQuality(80.6)).toBe(81);
    expect(clampJpegQuality("x")).toBe(95);
    expect(clampJpegQuality(Number.NaN)).toBe(95);
    // Missing is the default, not 0 (which would clamp to the lowest quality).
    expect(clampJpegQuality(null)).toBe(95);
    expect(clampJpegQuality("")).toBe(95);
    expect(clampJpegQuality(undefined)).toBe(95);
    expect(clampJpegQuality(true)).toBe(95);
    expect(clampJpegQuality("80")).toBe(80);
  });
});

describe("remembered frame format (app store)", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("starts as PNG and is persisted", () => {
    const s = useAppStore.getState();
    expect(s.packageImageFormat).toBe("png");
    expect(s.packageJpegQuality).toBe(95);
    expect(PERSISTED_KEYS).toContain("packageImageFormat");
    expect(PERSISTED_KEYS).toContain("packageJpegQuality");
  });

  it("stores a choice, cleaned", () => {
    useAppStore.getState().setPackageImage({ format: "jpg", quality: 72 });
    expect(useAppStore.getState().packageImageFormat).toBe("jpg");
    expect(useAppStore.getState().packageJpegQuality).toBe(72);
    useAppStore.getState().setPackageImage({ format: "png", quality: 400 });
    expect(useAppStore.getState().packageImageFormat).toBe("png");
    expect(useAppStore.getState().packageJpegQuality).toBe(100);
  });

  it("reads a corrupt stored value as PNG / a clamped quality", () => {
    const merge = useAppStore.persist.getOptions().merge!;
    const current = useAppStore.getInitialState();
    const merged = merge({ packageImageFormat: "webp", packageJpegQuality: -3 }, current);
    expect(merged.packageImageFormat).toBe("png");
    expect(merged.packageJpegQuality).toBe(1);
    const kept = merge({ packageImageFormat: "jpg", packageJpegQuality: 88 }, current);
    expect(kept.packageImageFormat).toBe("jpg");
    expect(kept.packageJpegQuality).toBe(88);
    const fresh = merge({}, current);
    expect(fresh.packageImageFormat).toBe("png");
    expect(fresh.packageJpegQuality).toBe(95);
  });
});

describe("withImageFormat against the installed sleap-io.js", () => {
  it("adds nothing for PNG or no choice (exports write as before)", () => {
    const opts = { embed: "user" };
    expect(withImageFormat(opts, undefined)).toBe(opts);
    expect(withImageFormat(opts, null)).toBe(opts);
    expect(withImageFormat(opts, { format: "png", quality: 50 })).toBe(opts);
  });

  it("knows whether this sleap-io.js can write JPEG frames", () => {
    expect(canWriteJpegFrames()).toBe(LIBRARY_HAS_JPEG);
    if (!LIBRARY_HAS_JPEG) {
      console.info(
        "[packageImageFormat] the installed sleap-io.js has no imageFormat: JPEG is refused"
      );
    }
  });

  it("adds imageFormat and imageQuality for JPEG, or refuses it on a release without them", () => {
    const jpeg = { format: "jpg" as const, quality: 85 };
    if (LIBRARY_HAS_JPEG) {
      expect(withImageFormat<Record<string, unknown>>({ embed: "user" }, jpeg)).toEqual({
        embed: "user",
        imageFormat: "jpg",
        imageQuality: 85,
      });
    } else {
      expect(() => withImageFormat({ embed: "user" }, jpeg)).toThrow(JPEG_FRAMES_UNAVAILABLE);
    }
  });
});
