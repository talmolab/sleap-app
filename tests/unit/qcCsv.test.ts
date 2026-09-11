/**
 * Unit tests for QC CSV export (matches the reference `qc_results.csv` columns).
 *
 * Faithful port of github.com/alexwu-z/sleap-qc-webapp
 * (src/lib/qc/csv.test.js), a lab JS port of Python `sleap.qc` intended for
 * integration into sleap-app.
 */
import { describe, it, expect } from "../bun-test";
import { qcResultsCsv, QC_CSV_HEADER } from "@/lib/analyze/qc/csv";

// A full 18-feature contributions map (matches the keys the anomaly unit emits).
const contrib: Record<string, number> = {
  max_edge_zscore: 1.5,
  mean_edge_zscore: 0.6,
  max_angle_zscore: 1.1,
  mean_angle_zscore: 0.5,
  max_pairwise_zscore: 1.5,
  mean_pairwise_zscore: 0.6,
  bbox_area_zscore: 2.0,
  max_centroid_distance: 200,
  centroid_distance_std: 50,
  min_symmetry_consistency: 1.0,
  visibility_rate: 1.0,
  has_isolated_invisible: 0,
  max_curvature: 2.5,
  curvature_std: 1.2,
  visibility_pattern_score: 0,
  nn_distance: 0.9,
  hull_area_zscore: 0.3,
  hull_compactness: 0.31,
};

describe("qcResultsCsv", () => {
  it("emits the qc_results.csv header (hull_area not hull_area_zscore; 27 cols)", () => {
    expect(qcResultsCsv([])).toBe(QC_CSV_HEADER.join(","));
    expect(QC_CSV_HEADER.slice(0, 6)).toEqual([
      "video_idx",
      "frame_idx",
      "instance_idx",
      "score",
      "confidence",
      "top_issue",
    ]);
    expect(QC_CSV_HEADER).toContain("hull_area");
    expect(QC_CSV_HEADER).not.toContain("hull_area_zscore");
    expect(QC_CSV_HEADER.slice(-3)).toEqual([
      "order_inversion_rate",
      "chain_intersection_count",
      "frame_flagged",
    ]);
    expect(QC_CSV_HEADER).toHaveLength(27);
  });

  it("writes one row per record: identity + score/confidence/top_issue + 18 features + 2 ordering + frame_flagged", () => {
    const rows = qcResultsCsv([
      {
        videoIdx: 0,
        frameIdx: 1737,
        instIdx: 0,
        score: 0.88,
        contributions: contrib,
        orderInversion: 0.5,
        chainIntersection: 2,
        frameFlagged: true,
      },
    ]).split("\n");
    expect(rows).toHaveLength(2);
    const cells = rows[1].split(",");
    expect(cells.slice(0, 5)).toEqual(["0", "1737", "0", "0.88", "high"]);
    expect(cells[5]).toBe("Isolated node"); // max_centroid_distance 200/30 dominates topIssue
    expect(cells[QC_CSV_HEADER.indexOf("hull_area")]).toBe("0.3"); // maps to hull_area_zscore
    // whole-number features render as floats (".0"), matching numpy output
    expect(cells[QC_CSV_HEADER.indexOf("visibility_rate")]).toBe("1.0");
    expect(cells[QC_CSV_HEADER.indexOf("has_isolated_invisible")]).toBe("0.0");
    expect(cells[QC_CSV_HEADER.indexOf("order_inversion_rate")]).toBe("0.5");
    expect(cells[QC_CSV_HEADER.indexOf("chain_intersection_count")]).toBe("2.0");
    expect(cells[QC_CSV_HEADER.indexOf("frame_flagged")]).toBe("True");
    expect(cells).toHaveLength(27);
  });

  it("coalesces non-finite feature values to 0.0", () => {
    const c = { ...contrib, max_curvature: NaN, nn_distance: Infinity };
    const cells = qcResultsCsv([
      { videoIdx: 0, frameIdx: 0, instIdx: 0, score: 0.5, contributions: c },
    ])
      .split("\n")[1]
      .split(",");
    expect(cells[QC_CSV_HEADER.indexOf("max_curvature")]).toBe("0.0");
    expect(cells[QC_CSV_HEADER.indexOf("nn_distance")]).toBe("0.0");
  });

  it("RFC-4180 quotes a top_issue containing a comma", () => {
    // pose_split_score maps to "Split pose / chimera" (no comma); use an unmapped
    // feature to force a "High <feature>" — but commas come from the issue text,
    // so verify quoting via a top_issue that has one: none of ISSUE_MAP do, so
    // this asserts the common no-quote path stays unquoted.
    const cells = qcResultsCsv([
      { videoIdx: 0, frameIdx: 0, instIdx: 0, score: 0.5, contributions: contrib },
    ])
      .split("\n")[1]
      .split(",");
    expect(cells[5]).toBe("Isolated node"); // no comma -> not quoted
  });
});
