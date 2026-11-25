// Why: the Grid and the progress line count what's left to review; a tile per flagged instance and honest counts are the whole feature.
import { describe, it, expect } from "../bun-test";
import { qcTiles, qcFrameFlagCount, qcProgress, qcFlagTotal } from "@/lib/qcTriage";
import { thumbCrop } from "@/lib/qcThumbs";
import type { QcQueueEntry } from "@/stores/qcStore";
import type { QcFinding } from "@/lib/analyze/labelQc";
import { anomalyAt } from "./helpers/automationFixture";

const rule = (frameIdx: number, kind: QcFinding["kind"], instanceIdx?: number) =>
  ({ kind, message: kind, video: {} as never, videoIdx: 0, frameIdx, instanceIdx }) as QcFinding;
const flagged = (frameIdx: number, instIdx: number, by: "anomaly" | "gmm" | "both", score = 0.9) => ({
  a: { ...anomalyAt(frameIdx, instIdx, score, [1, 2]), gmmNode: 2 },
  v: { flagged: true, by, score, confidence: "high" as const, issue: "x" },
});
const entry = (frameIdx: number, parts: Partial<QcQueueEntry>, videoIdx = 0): QcQueueEntry => ({
  videoIdx,
  frameIdx,
  rules: [],
  definite: false,
  anomalies: [],
  worst: 0,
  ok: [],
  ...parts,
});

const QUEUE: QcQueueEntry[] = [
  // Frame 3: instance 0 is a duplicate AND an anomaly (one tile); instance 1 a GMM flag.
  entry(3, { rules: [rule(3, "duplicate", 0)], anomalies: [flagged(3, 0, "anomaly"), flagged(3, 1, "gmm", 0.97)] }),
  // Frame 5: a frame-level flag and a chirality flag (soft) on instance 0, marked OK.
  entry(5, { rules: [rule(5, "incomplete_frame"), rule(5, "chirality", 0)], ok: [0] }),
  // Frame 9 (video 1): an anomaly on instance 0.
  entry(9, { anomalies: [flagged(9, 0, "both", 0.8)] }, 1),
];

describe("qcTiles", () => {
  it("makes one tile per flagged instance, rules first, then the scores that flagged it", () => {
    const tiles = qcTiles(QUEUE, new Set());
    expect(tiles.map((t) => `${t.frameIdx}/${t.instIdx}`)).toEqual(["3/0", "3/1", "5/0", "9/0"]);
    expect(tiles[0].kinds).toEqual(["Duplicate", "Anomaly"]);
    expect(tiles[0].definite).toBe(true);
    expect(tiles[1].kinds).toEqual(["GMM"]);
    expect(tiles[1].nodes).toEqual([2]); // the GMM's node
    expect(tiles[2]).toMatchObject({ kinds: ["Chirality (L/R)"], definite: false, score: null, status: "ignored" });
    expect(tiles[3].kinds).toEqual(["Anomaly", "GMM"]);
  });

  it("marks tiles on frames edited since the run", () => {
    const tiles = qcTiles(QUEUE, new Set(["0:3"]));
    expect(tiles.filter((t) => t.status === "edited").map((t) => t.instIdx)).toEqual([0, 1]);
  });
});

describe("progress", () => {
  it("counts what's left, by issue type and by video", () => {
    const p = qcProgress(qcTiles(QUEUE, new Set(["0:3"])), (v) => `v${v}`);
    expect(p).toMatchObject({ total: 4, ignored: 1, edited: 2, left: 1 });
    expect(p.byKind.find((r) => r.label === "Anomaly")).toEqual({ label: "Anomaly", total: 2, left: 1 });
    expect(p.byVideo).toEqual([
      { videoIdx: 0, label: "v0", total: 3, left: 0 },
      { videoIdx: 1, label: "v1", total: 1, left: 1 },
    ]);
  });

  it("counts frame-level flags apart (no instance to show), skipping edited frames", () => {
    expect(qcFrameFlagCount(QUEUE, new Set())).toBe(1);
    expect(qcFrameFlagCount(QUEUE, new Set(["0:5"]))).toBe(0);
  });

  // Why: "last run → this run" compares whole runs, so OK marks don't count as fixes.
  it("totals every flag, ignored ones included, for run-to-run comparison", () => {
    expect(qcFlagTotal(QUEUE)).toBe(5);
  });
});

describe("thumbCrop", () => {
  it("is a square around the visible points with a margin, centred on them", () => {
    const c = thumbCrop([[10, 20], [110, 40], [NaN, NaN]])!;
    expect(c.size).toBeCloseTo(100 * 1.35 + 24);
    expect(c.x + c.size / 2).toBeCloseTo(60);
    expect(c.y + c.size / 2).toBeCloseTo(30);
    expect(thumbCrop([[NaN, NaN]])).toBeNull();
  });
});
