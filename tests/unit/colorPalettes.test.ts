/**
 * Tests for color palette utilities.
 */

import { describe, it, expect } from "../bun-test";
import {
  getPaletteColor,
  rgbToCSS,
  rgbToHex,
  PALETTES,
} from "@/lib/colorPalettes";

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
});
