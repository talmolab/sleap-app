import { describe, it, expect } from "../bun-test";
import { formatCompactNumber } from "@/lib/formatNumber";

describe("formatCompactNumber", () => {
  it("uses exponential for tiny magnitudes (loss-scale)", () => {
    expect(formatCompactNumber(0.000487)).toBe("4.87e-4");
  });
  it("uses exponential for huge magnitudes", () => {
    expect(formatCompactNumber(12345)).toBe("1.23e+4");
  });
  it("uses up to 4 decimals otherwise, trimming trailing zeros", () => {
    expect(formatCompactNumber(1.2345)).toBe("1.2345");
    expect(formatCompactNumber(0.5)).toBe("0.5");
    expect(formatCompactNumber(0)).toBe("0");
  });
  it("returns empty for non-finite values", () => {
    expect(formatCompactNumber(Number.NaN)).toBe("");
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe("");
  });
});
