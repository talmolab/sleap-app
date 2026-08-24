/**
 * Tests for color palette utilities.
 */

import { describe, it, expect } from "../bun-test";
import {
  getPaletteColor,
  getInstanceColor,
  hasAssignedTracks,
  resolveColorTarget,
  rgbToCSS,
  rgbToHex,
  PALETTES,
} from "@/lib/colorPalettes";
import {
  Labels,
  LabeledFrame,
  Instance,
  Skeleton,
  Track,
  type Video,
} from "@talmolab/sleap-io.js";

const video = {} as unknown as Video;

function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name: "test" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
const sk = makeSkeleton();

const userInst = (track?: Track) => {
  const inst = Instance.fromArray(
    [
      [1, 1],
      [2, 2],
    ],
    sk,
  );
  if (track) inst.track = track;
  return inst;
};

describe("colorPalettes", () => {
  describe("getPaletteColor", () => {
    it("returns the correct first color from standard palette", () => {
      const color = getPaletteColor("standard", 0);
      expect(color).toEqual([0, 114, 189]);
    });

    it("returns the correct second color from standard palette", () => {
      const color = getPaletteColor("standard", 1);
      expect(color).toEqual([217, 83, 25]);
    });

    it("wraps on overflow", () => {
      const paletteLen = PALETTES.standard.length;
      const color = getPaletteColor("standard", paletteLen);
      // Should wrap to index 0
      expect(color).toEqual(PALETTES.standard[0]);
    });

    it("wraps correctly at double the palette length", () => {
      const paletteLen = PALETTES.standard.length;
      const color = getPaletteColor("standard", paletteLen + 2);
      expect(color).toEqual(PALETTES.standard[2]);
    });

    it("falls back to standard palette for unknown palette name", () => {
      const color = getPaletteColor("nonexistent", 0);
      expect(color).toEqual(PALETTES.standard[0]);
    });

    it("works with five+ palette", () => {
      const color = getPaletteColor("five+", 0);
      expect(color).toEqual([228, 26, 28]);
    });

    it("works with alphabet palette", () => {
      const color = getPaletteColor("alphabet", 0);
      expect(color).toEqual([240, 163, 255]);
    });
  });

  describe("rgbToCSS", () => {
    it("produces valid rgb() CSS without alpha", () => {
      const result = rgbToCSS([255, 128, 0]);
      expect(result).toBe("rgb(255, 128, 0)");
    });

    it("produces valid rgba() CSS with alpha", () => {
      const result = rgbToCSS([255, 128, 0], 0.5);
      expect(result).toBe("rgba(255, 128, 0, 0.5)");
    });

    it("uses rgb() when alpha is 1", () => {
      const result = rgbToCSS([0, 0, 0], 1);
      expect(result).toBe("rgb(0, 0, 0)");
    });

    it("handles edge case rgb values", () => {
      const result = rgbToCSS([0, 0, 0]);
      expect(result).toBe("rgb(0, 0, 0)");
    });
  });

  describe("rgbToHex", () => {
    it("produces valid hex for standard colors", () => {
      const result = rgbToHex([255, 128, 0]);
      expect(result).toBe("#ff8000");
    });

    it("pads single-digit hex values", () => {
      const result = rgbToHex([0, 0, 0]);
      expect(result).toBe("#000000");
    });

    it("handles white", () => {
      const result = rgbToHex([255, 255, 255]);
      expect(result).toBe("#ffffff");
    });

    it("handles the first standard palette color", () => {
      const color = PALETTES.standard[0];
      const result = rgbToHex(color);
      // [0, 114, 189] -> #0072bd
      expect(result).toBe("#0072bd");
    });
  });

  describe("hasAssignedTracks", () => {
    it("returns false for null/undefined labels", () => {
      expect(hasAssignedTracks(null)).toBe(false);
      expect(hasAssignedTracks(undefined)).toBe(false);
    });

    it("returns false when no instance has a track", () => {
      const labels = new Labels({
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [userInst()] }),
        ],
        skeletons: [sk],
        videos: [video],
      });
      expect(hasAssignedTracks(labels)).toBe(false);
    });

    it("returns true once any instance across any frame has a track", () => {
      const track = new Track("t1");
      const labels = new Labels({
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [userInst()] }),
          new LabeledFrame({ video, frameIdx: 1, instances: [userInst(track)] }),
        ],
        skeletons: [sk],
        videos: [video],
      });
      expect(hasAssignedTracks(labels)).toBe(true);
    });

    it("is not fooled by an orphaned track sitting in labels.tracks alone", () => {
      // A track can exist in labels.tracks without being assigned to any
      // instance (see DeleteUnusedTracks) — hasAssignedTracks must scan
      // actual instance assignments, not just track-list presence.
      const track = new Track("orphan");
      const labels = new Labels({
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [userInst()] }),
        ],
        skeletons: [sk],
        videos: [video],
        tracks: [track],
      });
      expect(hasAssignedTracks(labels)).toBe(false);
    });
  });

  describe("resolveColorTarget", () => {
    it("resolves auto to node when the project has no assigned tracks", () => {
      expect(resolveColorTarget("auto", false)).toBe("node");
    });

    it("resolves auto to track once the project has assigned tracks", () => {
      expect(resolveColorTarget("auto", true)).toBe("track");
    });

    it("passes concrete modes through unchanged regardless of track state", () => {
      expect(resolveColorTarget("instance", true)).toBe("instance");
      expect(resolveColorTarget("track", false)).toBe("track");
      expect(resolveColorTarget("node", true)).toBe("node");
      expect(resolveColorTarget("edge", false)).toBe("edge");
    });
  });

  describe("getInstanceColor with auto mode", () => {
    it("colors by node (neutral gray) when auto and no tracks are assigned", () => {
      const color = getInstanceColor("standard", "auto", 0, null, [], false, false, false);
      expect(color).toEqual([180, 180, 180]);
    });

    it("colors by track when auto and the project has assigned tracks", () => {
      const track = new Track("t1");
      const tracks = [track];
      const color = getInstanceColor("standard", "auto", 0, track, tracks, false, false, true);
      expect(color).toEqual(getPaletteColor("standard", 0));
    });

    it("still shows the flat predicted-instance color regardless of auto resolution", () => {
      const color = getInstanceColor("standard", "auto", 0, null, [], true, false, true);
      expect(color).toEqual([128, 128, 128]);
    });
  });
});
