/**
 * Unit tests for the QC verdict layer: raw feature contributions -> a readable
 * "what's wrong" (top issue), confidence bucket, direction, top contributors.
 *
 * The topIssue/confidence/withDirection/topContributions cases are a faithful
 * port of github.com/alexwu-z/sleap-qc-webapp (src/lib/qc/checks/explain.test.js),
 * a lab JS port of Python `sleap.qc` intended for integration into sleap-app.
 * The issueForFeature/DIRECTIONAL_FEATURES cases are added here.
 */
import { describe, it, expect } from "../bun-test";
import {
  topIssue,
  confidence,
  topContributions,
  withDirection,
  issueForFeature,
  DIRECTIONAL_FEATURES,
} from "@/lib/analyze/qc/explain";

describe("topIssue", () => {
  it("maps the dominant feature to a readable issue", () => {
    expect(
      topIssue({ max_edge_zscore: 7.2, max_angle_zscore: 1.0 }),
    ).toMatchObject({
      feature: "max_edge_zscore",
      issue: "Unusual edge length",
    });
  });

  it("normalizes raw-distance features before comparing (scale factors)", () => {
    // raw 40 / 30 = 1.33 beats a 1.0σ z-score after scaling
    expect(
      topIssue({ max_centroid_distance: 40, max_edge_zscore: 1.0 }).issue,
    ).toBe("Isolated node");
    // but a 2σ z-score (2/1) beats 40/30 = 1.33
    expect(
      topIssue({ max_centroid_distance: 40, max_edge_zscore: 2.0 }).feature,
    ).toBe("max_edge_zscore");
  });

  it("ignores the no-symmetry sentinel (min_symmetry_consistency == 1.0)", () => {
    expect(
      topIssue({ min_symmetry_consistency: 1.0, max_edge_zscore: 0.5 }).feature,
    ).toBe("max_edge_zscore");
  });

  it("falls back to 'High <feature>' for unmapped features and 'Unknown' when empty", () => {
    expect(topIssue({ hull_compactness: 9 }).issue).toBe("High hull_compactness");
    expect(topIssue({}).issue).toBe("Unknown");
    expect(topIssue(null).issue).toBe("Unknown");
  });
});

describe("confidence", () => {
  it("buckets the score", () => {
    expect(confidence(0.99)).toBe("high");
    expect(confidence(0.6)).toBe("medium");
    expect(confidence(0.2)).toBe("low");
  });
});

describe("withDirection", () => {
  it("appends increased/decreased for a known direction, leaves it alone otherwise", () => {
    expect(withDirection("Unusual edge length", 1)).toBe(
      "Unusual edge length (increased)",
    );
    expect(withDirection("Unusual edge length", -1)).toBe(
      "Unusual edge length (decreased)",
    );
    expect(withDirection("Unusual edge length", 0)).toBe("Unusual edge length");
  });
});

describe("topContributions", () => {
  it("returns the top-k features highest-first", () => {
    expect(topContributions({ a: 1, b: 5, c: 3 }, 2)).toEqual([
      ["b", 5],
      ["c", 3],
    ]);
  });

  it("defaults to k=3", () => {
    expect(topContributions({ a: 1, b: 5, c: 3, d: 4 })).toEqual([
      ["b", 5],
      ["d", 4],
      ["c", 3],
    ]);
  });
});

describe("issueForFeature / DIRECTIONAL_FEATURES", () => {
  it("issueForFeature maps a name, falls back, and is null for null", () => {
    expect(issueForFeature("nn_distance")).toBe("Unusual pose shape");
    expect(issueForFeature("hull_compactness")).toBe("High hull_compactness");
    expect(issueForFeature(null)).toBeNull();
  });

  it("DIRECTIONAL_FEATURES holds the signed z-score features", () => {
    expect(DIRECTIONAL_FEATURES.has("max_edge_zscore")).toBe(true);
    expect(DIRECTIONAL_FEATURES.has("hull_area_zscore")).toBe(true);
    expect(DIRECTIONAL_FEATURES.has("visibility_rate")).toBe(false);
  });
});
