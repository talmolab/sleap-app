/**
 * Unit tests for the model-evaluation metrics loader + boxplot math.
 *
 * Exercises the pure loading pipeline against a fixture run directory
 * (tests/fixtures/metrics), which contains ONLY `metrics.val.0.json` (no test
 * split) plus a `training_config.yaml`. That lets us assert:
 *   - the sleap-nn split fallback (requested "test" → falls back to "val"),
 *   - the normalized ModelMetrics / MetricsSummary shape,
 *   - training-config parsing (model type / architecture / nodes / timestamp),
 *   - the per-node distance boxplot quartiles (numpy-linear percentile,
 *     ignoring null/NaN).
 *
 * File access is injected (MetricsFsAccess backed by node:fs) so no Tauri
 * runtime is needed. The underlying sleap-nn evaluation is covered upstream.
 */

import { describe, it, expect } from "../bun-test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadModelMetrics,
  buildModelMetricsRow,
  resolveMetricsFile,
  normalizeMetrics,
  looksLikeMetrics,
  summarizeMetrics,
  parseTimestampFromRunName,
  joinPath,
  runDirName,
  type MetricsFsAccess,
} from "@/lib/metrics/loadModelMetrics";
import {
  computeNodeBoxplots,
  percentileSorted,
  distanceAxisMax,
} from "@/lib/metrics/boxplot";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/metrics");

/** node:fs-backed reader so the loader runs without the Tauri runtime. */
const diskFs: MetricsFsAccess = {
  async readTextFile(path: string) {
    return readFileSync(path, "utf-8");
  },
  async exists(path: string) {
    return existsSync(path);
  },
};

describe("path helpers", () => {
  it("joins with the directory's separator", () => {
    expect(joinPath("/a/b", "c.json")).toBe("/a/b/c.json");
    expect(joinPath("/a/b/", "c.json")).toBe("/a/b/c.json");
    expect(joinPath("C:\\a\\b", "c.json")).toBe("C:\\a\\b\\c.json");
  });

  it("extracts the run-dir basename", () => {
    expect(runDirName("/models/centered_instance_run/")).toBe("centered_instance_run");
    expect(runDirName("C:\\models\\run")).toBe("run");
  });
});

describe("resolveMetricsFile split fallback", () => {
  it("falls back from the requested 'test' split to 'val'", async () => {
    const found = await resolveMetricsFile(FIXTURE_DIR, diskFs, "test", 0);
    expect(found).not.toBeNull();
    expect(found!.split).toBe("val");
    expect(found!.path.endsWith("metrics.val.0.json")).toBe(true);
  });

  it("returns null when nothing matches", async () => {
    const empty: MetricsFsAccess = {
      async readTextFile() {
        throw new Error("nope");
      },
      async exists() {
        return false;
      },
    };
    expect(await resolveMetricsFile(FIXTURE_DIR, empty, "test", 0)).toBeNull();
  });
});

describe("loadModelMetrics (fixture)", () => {
  it("loads the val split when test is absent and tags mode 'oks'", async () => {
    const res = await loadModelMetrics(FIXTURE_DIR, { fs: diskFs, split: "test" });
    expect(res.splitLoaded).toBe("val");
    expect(res.metrics).not.toBeNull();
    expect(res.metrics!.mode).toBe("oks");
    expect(res.metrics!.split).toBe("val");
  });

  it("normalizes distance dists (5 pairs × 3 nodes, nulls preserved)", async () => {
    const { metrics } = await loadModelMetrics(FIXTURE_DIR, { fs: diskFs });
    const dist = metrics!.distance!;
    expect(dist.dists.length).toBe(5);
    expect(dist.dists[0].length).toBe(3);
    // Row 0 node 2 and row 2 node 0 are null in the fixture.
    expect(dist.dists[0][2]).toBeNull();
    expect(dist.dists[2][0]).toBeNull();
    expect(dist.frame_idxs).toEqual([0, 1, 2, 3, 4]);
  });

  it("summarizes the headline scalars", async () => {
    const { metrics } = await loadModelMetrics(FIXTURE_DIR, { fs: diskFs });
    const s = summarizeMetrics(metrics)!;
    expect(s.oksMAP).toBeCloseTo(0.6522, 6);
    expect(s.visPrecision).toBeCloseTo(0.9231, 6);
    expect(s.visRecall).toBeCloseTo(0.8571, 6);
    expect(s.distP95).toBeCloseTo(4.935, 6);
    expect(s.distP75).toBeCloseTo(3.975, 6);
    expect(s.distAvg).toBeCloseTo(3.1583, 6);
    expect(s.mOKS).toBeCloseTo(0.7842, 6);
    expect(s.mPCK).toBeCloseTo(0.821, 6);
  });

  it("parses the training config (type / arch / nodes / timestamp)", async () => {
    const { config } = await loadModelMetrics(FIXTURE_DIR, { fs: diskFs });
    expect(config).not.toBeNull();
    expect(config!.modelType).toBe("Centered Instance");
    expect(config!.architecture).toContain("UNet");
    expect(config!.architecture).toContain("max stride: 16");
    expect(config!.architecture).toContain("filters: 24");
    expect(config!.nodeNames).toEqual(["head", "thorax", "abdomen"]);
    expect(config!.runName).toBe("centered_instance_20260731_120000");
    expect(config!.timestamp).toBe("2026-07-31 12:00:00");
  });

  it("builds a full table row", async () => {
    const row = await buildModelMetricsRow(FIXTURE_DIR, { fs: diskFs });
    expect(row.path).toBe(FIXTURE_DIR);
    expect(row.modelType).toBe("Centered Instance");
    expect(row.summary!.oksMAP).toBeCloseTo(0.6522, 6);
    expect(row.metrics!.distance!.dists.length).toBe(5);
    expect(row.error).toBeUndefined();
  });

  it("captures loader failure as row.error rather than throwing", async () => {
    const throwingFs: MetricsFsAccess = {
      async readTextFile() {
        throw new Error("boom");
      },
      async exists() {
        return true; // force a read, which throws
      },
    };
    const row = await buildModelMetricsRow("/some/run", { fs: throwingFs });
    expect(row.metrics).toBeNull();
    expect(row.error).toContain("boom");
  });
});

describe("normalizeMetrics tolerance", () => {
  it("coerces NaN-ish scalars to null and empty input to unknown mode", () => {
    const m = normalizeMetrics({}, "train");
    expect(m.mode).toBe("unknown");
    expect(m.split).toBe("train");
    expect(summarizeMetrics(m)!.oksMAP).toBeNull();
  });

  it("reads mOKS from either a wrapper object or a bare number", () => {
    expect(normalizeMetrics({ mOKS: { mOKS: 0.5 } }).mOKS).toBe(0.5);
    expect(normalizeMetrics({ mOKS: 0.25 }).mOKS).toBe(0.25);
  });
});

describe("real sleap-nn JSON edge cases (reconciliation)", () => {
  // sleap-nn returns a scalar 0 (not an array) for the voc arrays when a split
  // has 0 matched pairs (a degenerate/empty split). The loader must not choke on
  // scalars where it types arrays, and must still surface the scalar headlines.
  it("empty-split: scalar-0 voc + scalar dists don't throw and summarize cleanly", () => {
    const emptySplit = {
      voc_metrics: {
        "oks_voc.mAP": 0,
        "oks_voc.mAR": 0,
        // normally arrays — come back as scalar 0 for an empty split:
        "oks_voc.AP": 0,
        "oks_voc.AR": 0,
        "oks_voc.precisions": 0,
        "oks_voc.recalls": 0,
        "pck_voc.mAP": 0,
        "pck_voc.mAR": 0,
      },
      mOKS: { mOKS: 0 },
      distance_metrics: { avg: 0, p50: 0, p95: 0, dists: 0, frame_idxs: 0, video_paths: 0 },
      pck_metrics: { mPCK: 0, "PCK@5": 0, "PCK@10": 0 },
      visibility_metrics: { tp: 0, fp: 0, tn: 0, fn: 0, precision: 0, recall: 0 },
    };
    const m = normalizeMetrics(emptySplit, "val");
    expect(m.mode).toBe("oks");
    // scalar dists/frame_idxs are guarded to empty arrays (→ boxplot "no data").
    expect(m.distance!.dists).toEqual([]);
    expect(m.distance!.frame_idxs).toEqual([]);
    const s = summarizeMetrics(m)!;
    expect(s.oksMAP).toBe(0);
    expect(s.mOKS).toBe(0);
    expect(s.visPrecision).toBe(0);
    expect(s.distAvg).toBe(0);
  });

  it("recognizes non-keypoint metric dicts via looksLikeMetrics", () => {
    expect(looksLikeMetrics({ detection_metrics: {} })).toBe(true);
    expect(looksLikeMetrics({ mask_metrics: {} })).toBe(true);
    expect(looksLikeMetrics({ semantic_metrics: {} })).toBe(true);
    expect(looksLikeMetrics({ voc_metrics: {} })).toBe(true);
    expect(looksLikeMetrics({})).toBe(false);
    expect(looksLikeMetrics(null)).toBe(false);
  });

  it("centroid model → mode 'centroid' with distance metrics, oks/voc null", () => {
    const centroid = {
      detection_metrics: { precision: 0.9, recall: 0.8 },
      distance_metrics: {
        avg: 2.0,
        p95: 4.0,
        dists: [[1.0, 2.0]],
        frame_idxs: [0],
        video_paths: ["/v.mp4"],
      },
    };
    const m = normalizeMetrics(centroid, "val");
    expect(m.mode).toBe("centroid");
    expect(m.voc).toBeUndefined();
    expect(m.distance!.avg).toBe(2.0);
    expect(m.distance!.dists.length).toBe(1);
    const s = summarizeMetrics(m)!;
    expect(s.oksMAP).toBeNull();
    expect(s.mOKS).toBeNull();
    expect(s.distAvg).toBe(2.0);
  });

  it("mask model → mode 'mask' and degrades to null headline metrics without throwing", () => {
    const mask = { mask_metrics: { iou: 0.7 }, mask_voc_metrics: {} };
    const m = normalizeMetrics(mask, "val");
    expect(m.mode).toBe("mask");
    const s = summarizeMetrics(m)!;
    expect(s.oksMAP).toBeNull();
    expect(s.distAvg).toBeNull();
    expect(s.visPrecision).toBeNull();
  });
});

describe("parseTimestampFromRunName", () => {
  it("parses separated and contiguous 4-digit-year timestamps (pre-Hydra-fix run names)", () => {
    expect(parseTimestampFromRunName("centered_instance_20260731_120000")).toBe("2026-07-31 12:00:00");
    expect(parseTimestampFromRunName("centered_instance_20260731120000")).toBe("2026-07-31 12:00:00");
    expect(parseTimestampFromRunName("run_20260731")).toBe("2026-07-31");
    expect(parseTimestampFromRunName("no_date_here")).toBeNull();
    expect(parseTimestampFromRunName(null)).toBeNull();
  });

  it("parses the current 2-digit-year run-name format (matches legacy SLEAP's own timestamp)", () => {
    // Default sleap-app run name: {YYMMDD_HHMMSS}.{head}.n={count}
    expect(parseTimestampFromRunName("260818_143012.centroid.n=342")).toBe("2026-08-18 14:30:12");
    // Doesn't misfire on an unrelated 6-digit run inside a longer digit block.
    expect(parseTimestampFromRunName("centered_instance_20260731_120000")).toBe("2026-07-31 12:00:00");
  });
});

describe("percentileSorted (numpy linear interpolation)", () => {
  it("interpolates between ranks", () => {
    const xs = [1, 2, 3, 4];
    expect(percentileSorted(xs, 0)).toBe(1);
    expect(percentileSorted(xs, 100)).toBe(4);
    expect(percentileSorted(xs, 50)).toBeCloseTo(2.5, 10);
    expect(percentileSorted(xs, 25)).toBeCloseTo(1.75, 10);
    expect(percentileSorted(xs, 75)).toBeCloseTo(3.25, 10);
  });

  it("handles empty and singleton arrays", () => {
    expect(Number.isNaN(percentileSorted([], 50))).toBe(true);
    expect(percentileSorted([7], 95)).toBe(7);
  });
});

describe("computeNodeBoxplots (per-node quartiles, nulls ignored)", () => {
  // Fixture dists (5 pairs × 3 nodes); nulls mark missing nodes.
  const dists: (number | null)[][] = [
    [2.1, 3.4, null],
    [1.8, 2.9, 5.1],
    [null, 3.1, 4.8],
    [2.5, 2.2, 3.9],
    [1.9, null, 4.2],
  ];

  it("produces one box per node with the right labels", () => {
    const boxes = computeNodeBoxplots(dists, ["head", "thorax", "abdomen"]);
    expect(boxes.map((b) => b.node)).toEqual(["head", "thorax", "abdomen"]);
  });

  it("ignores null/NaN entries when counting samples", () => {
    const boxes = computeNodeBoxplots(dists, ["head", "thorax", "abdomen"]);
    // head col had one null (row 2), thorax one null (row 4).
    expect(boxes[0].count).toBe(4);
    expect(boxes[1].count).toBe(4);
    expect(boxes[2].count).toBe(4);
  });

  it("computes correct five-number summaries (head node)", () => {
    // head finite values: [2.1, 1.8, 2.5, 1.9] -> sorted [1.8, 1.9, 2.1, 2.5]
    const head = computeNodeBoxplots(dists, ["head", "thorax", "abdomen"])[0];
    expect(head.min).toBeCloseTo(1.8, 10);
    expect(head.max).toBeCloseTo(2.5, 10);
    expect(head.q1).toBeCloseTo(1.875, 10); // p25
    expect(head.median).toBeCloseTo(2.0, 10); // p50
    expect(head.q3).toBeCloseTo(2.2, 10); // p75
    expect(head.p95).toBeCloseTo(2.44, 10); // p95
  });

  it("computes correct summary for a different node (abdomen)", () => {
    // abdomen finite values: [5.1, 4.8, 3.9, 4.2] -> sorted [3.9, 4.2, 4.8, 5.1]
    const abd = computeNodeBoxplots(dists, ["head", "thorax", "abdomen"])[2];
    expect(abd.min).toBeCloseTo(3.9, 10);
    expect(abd.median).toBeCloseTo(4.5, 10);
    expect(abd.max).toBeCloseTo(5.1, 10);
  });

  it("falls back to node-index labels and marks all-null nodes as empty", () => {
    const boxes = computeNodeBoxplots([[null, 1.0]]);
    expect(boxes[0].node).toBe("node 0");
    expect(boxes[0].count).toBe(0);
    expect(Number.isNaN(boxes[0].median)).toBe(true);
    expect(boxes[1].count).toBe(1);
  });
});

describe("distanceAxisMax", () => {
  it("rounds the 95th percentile up to a nice multiple of 5", () => {
    // All finite fixture values -> p95 ~4.94 -> ceil(ceil(4.94/5)+1)*5 = 10.
    const dists: (number | null)[][] = [
      [2.1, 3.4, null],
      [1.8, 2.9, 5.1],
      [null, 3.1, 4.8],
      [2.5, 2.2, 3.9],
      [1.9, null, 4.2],
    ];
    expect(distanceAxisMax(dists)).toBe(10);
  });

  it("returns a floor of 5 when there is no finite data", () => {
    expect(distanceAxisMax([[null, null]])).toBe(5);
    expect(distanceAxisMax([])).toBe(5);
  });
});
