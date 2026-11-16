/**
 * Box detector metrics (#488): sleap-nn writes flat `bbox_*` keys to
 * `metrics.{split}.{idx}.json` and per-epoch `eval/val/bbox_*` columns to
 * `training_log.csv`. The fixture is a real CenterNet detector trained from
 * the app on a fly project (tests/fixtures/metrics/bbox_centernet).
 */
import { describe, it, expect, afterEach } from "../bun-test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import {
  buildModelMetricsRow,
  looksLikeMetrics,
  normalizeMetrics,
  parseBboxHistory,
  summarizeMetrics,
  type MetricsFsAccess,
} from "@/lib/metrics/loadModelMetrics";
import { ModelMetricsDialog } from "@/components/dialogs/ModelMetricsDialog";
import { DetailedModelMetricsDialog } from "@/components/dialogs/DetailedModelMetricsDialog";
import { finiteRuns } from "@/components/charts/MiniLineChart";

afterEach(() => cleanup());

const DIR = join(import.meta.dir, "../fixtures/metrics/bbox_centernet");
const POSE_DIR = join(import.meta.dir, "../fixtures/metrics");
const raw = JSON.parse(readFileSync(join(DIR, "metrics.val.0.json"), "utf-8"));
const diskFs: MetricsFsAccess = {
  async readTextFile(p: string) {
    return readFileSync(p, "utf-8");
  },
  async exists(p: string) {
    return existsSync(p);
  },
};

describe("normalizing box metrics", () => {
  it("recognizes sleap-nn's flat bbox_* keys", () => {
    expect(looksLikeMetrics(raw)).toBe(true);
    const m = normalizeMetrics(raw, "val");
    expect(m.mode).toBe("bbox");
    const b = m.bbox!;
    expect(b.mAP).toBeCloseTo(0.70617, 4);
    expect(b.AP50).toBe(1);
    expect(b.AP75).toBeCloseTo(0.93721, 4);
    expect(b.meanIoU).toBeCloseTo(0.84750, 4);
    expect([b.tp, b.fp, b.fn]).toEqual([42, 0, 0]);
    expect([b.nFrames, b.nGt, b.nPred]).toEqual([21, 42, 42]);
    expect(b.iouThresholds).toHaveLength(10);
    expect(b.iouThresholds[0]).toBe(0.5);
    expect(b.categories).toEqual(["object"]);
    expect(b.apPerClass).toHaveLength(1);
    expect(b.apPerClass[0]).toHaveLength(10);
    expect(b.prCurve!.recall).toHaveLength(42);
    expect(b.predictFps).toBeGreaterThan(0);
  });

  it("summarizes box columns and leaves pose columns empty", () => {
    const s = summarizeMetrics(normalizeMetrics(raw))!;
    expect(s.bboxMAP).toBeCloseTo(0.70617, 4);
    expect(s.bboxAP50).toBe(1);
    expect(s.bboxMeanIoU).toBeCloseTo(0.8475, 4);
    expect(s.oksMAP).toBeNull();
    expect(s.distAvg).toBeNull();
  });

  it("pose metrics are untouched (no bbox section)", async () => {
    const pose = JSON.parse(readFileSync(join(POSE_DIR, "metrics.val.0.json"), "utf-8"));
    const m = normalizeMetrics(pose);
    expect(m.mode).toBe("oks");
    expect(m.bbox).toBeUndefined();
    expect(summarizeMetrics(m)!.bboxMAP).toBeNull();
  });

  it("NaN-serialized (null) values come through as null", () => {
    const m = normalizeMetrics({ ...raw, bbox_mAP: null, bbox_f1_threshold: null });
    expect(m.mode).toBe("bbox");
    expect(m.bbox!.mAP).toBeNull();
    expect(m.bbox!.f1Threshold).toBeNull();
  });
});

describe("parseBboxHistory", () => {
  it("reads eval/val/bbox_* columns per epoch", () => {
    const h = parseBboxHistory(readFileSync(join(DIR, "training_log.csv"), "utf-8"))!;
    expect(h.epoch).toEqual([0, 1, 2, 3, 4]);
    expect(h.mAP[4]).toBeCloseTo(0.70617, 4);
    expect(h.AP50.every((v) => v !== null)).toBe(true);
    expect(h.meanIoU[4]).toBeCloseTo(0.8475, 3);
  });

  it("keeps epochs without an eval as gaps, and returns null without box columns", () => {
    const csv = "epoch,train/loss,eval/val/bbox_mAP\n0,1.0,\n1,0.9,0.5\n";
    const h = parseBboxHistory(csv)!;
    expect(h.epoch).toEqual([0, 1]);
    expect(h.mAP).toEqual([null, 0.5]);
    expect(h.AP50).toEqual([null, null]);
    expect(parseBboxHistory("epoch,train/loss\n0,1\n")).toBeNull();
  });
});

describe("loading a box detector run", () => {
  it("builds a table row with box metrics and per-epoch history", async () => {
    const row = await buildModelMetricsRow(DIR, { fs: diskFs });
    expect(row.error).toBeUndefined();
    expect(row.modelType).toBe("Box Detector (CenterNet)");
    expect(row.metrics!.mode).toBe("bbox");
    expect(row.metrics!.bboxHistory!.epoch).toHaveLength(5);
    expect(row.summary!.bboxMAP).toBeCloseTo(0.70617, 4);
  });
});

describe("finiteRuns", () => {
  it("splits a series at null/NaN gaps", () => {
    expect(finiteRuns([0, 1, 2, 3], [0.1, null, 0.3, 0.4])).toEqual([[[0, 0.1]], [[2, 0.3], [3, 0.4]]]);
    expect(finiteRuns([0, 1], [Number.NaN, null])).toEqual([]);
  });
});

describe("metrics dialogs with a box detector", () => {
  it("the table adds box columns only when a box model is listed", async () => {
    const row = await buildModelMetricsRow(DIR, { fs: diskFs });
    render(<ModelMetricsDialog open onOpenChange={() => {}} runDirs={[DIR]} buildRow={async () => row} />);
    expect(await screen.findByText("Box mAP")).toBeInTheDocument();
    expect(screen.getByText("Box IoU")).toBeInTheDocument();
    expect(screen.getByText("0.7062")).toBeInTheDocument();
    expect(screen.getByText("1.0000")).toBeInTheDocument();
  });

  it("the table has no box columns for pose models", async () => {
    const row = await buildModelMetricsRow(POSE_DIR, { fs: diskFs });
    render(<ModelMetricsDialog open onOpenChange={() => {}} runDirs={[POSE_DIR]} buildRow={async () => row} />);
    expect(await screen.findByText("OKS mAP")).toBeInTheDocument();
    expect(screen.queryByText("Box mAP")).toBeNull();
  });

  it("the detail view shows box scalars and charts instead of the node boxplot", async () => {
    const row = await buildModelMetricsRow(DIR, { fs: diskFs });
    render(<DetailedModelMetricsDialog open onOpenChange={() => {}} row={row} />);
    expect(await screen.findByText("Box mAP (IoU 0.50:0.95)")).toBeInTheDocument();
    expect(screen.getByText("0.70617")).toBeInTheDocument();
    expect(screen.getByText("Precision (score ≥ 0.61)")).toBeInTheDocument();
    // Counts print as integers.
    expect(screen.getByText("True positives").nextSibling?.textContent).toBe("42");
    expect(screen.getByRole("img", { name: "Box AP by IoU threshold" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Box precision-recall curve" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Validation box metrics per epoch" })).toBeInTheDocument();
    expect(screen.queryByText(/Per-node distance/)).toBeNull();
  });
});
