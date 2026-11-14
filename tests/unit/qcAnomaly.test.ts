/**
 * Unit tests for scoreLabelsAnomaly — the Phase-1 anomaly orchestrator that
 * fits the QC detector over a whole Labels and scores every instance.
 *
 * Exercises the full engine end-to-end on a real .slp fixture
 * (centered_pair.slp: 24-node fly skeleton, 140 instances over 70 frames),
 * mirroring the reference's computeAnomalyUnit path (LOO nn-distances) from
 * github.com/alexwu-z/sleap-qc-webapp, a lab JS port of Python `sleap.qc`.
 */
import { describe, it, expect } from "../bun-test";
import { topIssue } from "@/lib/analyze/qc/explain";
import {
  loadSlp,
  Skeleton,
  Video,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Labels as IoLabels,
} from "@talmolab/sleap-io.js";
import {
  anomalyVerdict,
  scoreLabelsAnomaly,
  scoreLabelsAnomalyAsync,
  type AnomalyInstance,
} from "@/lib/analyze/qc/anomaly";
import { makeQCConfig } from "@/lib/analyze/qc/config";
import type { Labels } from "@/types";

const loadFixture = async () =>
  loadSlp(await Bun.file("tests/fixtures/centered_pair.slp").arrayBuffer(), {
    openVideos: false,
  });

/** In-memory Labels whose frames each hold one USER + one PREDICTED instance. */
function mixedUserPredictedLabels(nFrames = 6): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  const video = new Video({
    filename: "/v/test.mp4",
    backendMetadata: { shape: [nFrames, 480, 640, 3] },
    openBackend: false,
  });
  const labeledFrames: LabeledFrame[] = [];
  for (let f = 0; f < nFrames; f++) {
    const user = Instance.fromArray([[10 + f, 10], [20 + f, 20]], skeleton);
    const pred = PredictedInstance.fromArray(
      [[100 + f, 100], [140 + f, 300]], // deliberately different shape
      skeleton,
      0.9,
    );
    labeledFrames.push(
      new LabeledFrame({ video, frameIdx: f, instances: [user, pred] }),
    );
  }
  return new IoLabels({
    labeledFrames,
    skeletons: [skeleton],
    videos: [video],
  }) as unknown as Labels;
}

describe("scoreLabelsAnomaly", () => {
  it("scores every instance of a real .slp in [0,1] with 18 features", async () => {
    const r = scoreLabelsAnomaly(await loadFixture());
    expect(r.featureNames).toHaveLength(18);
    expect(r.instances).toHaveLength(140);
    for (const inst of r.instances) {
      expect(inst.score).toBeGreaterThanOrEqual(0);
      expect(inst.score).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(inst.confidence);
      expect(typeof inst.topIssue).toBe("string");
      expect(inst.topIssue.length).toBeGreaterThan(0);
      expect(Object.keys(inst.contributions)).toHaveLength(18);
      expect(inst.videoIdx).toBe(0);
      expect(inst.frameIdx).toBeGreaterThanOrEqual(0);
      expect(inst.instIdx).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the nodes behind each instance's top issue", async () => {
    const r = scoreLabelsAnomaly(await loadFixture());
    const nNodes = 24;
    for (const i of r.instances) {
      const feature = topIssue(i.contributions).feature;
      // Node-localizable features always name nodes; visibility/bbox/NN never do.
      const localizable = [
        "max_edge_zscore",
        "max_angle_zscore",
        "max_pairwise_zscore",
        "has_isolated_invisible",
        "max_centroid_distance",
      ].includes(feature ?? "");
      if (localizable) expect(i.issueNodes.length).toBeGreaterThan(0);
      if (feature === "visibility_rate") expect(i.issueNodes).toEqual([]);
      if (feature === "max_edge_zscore" || feature === "max_pairwise_zscore")
        expect(i.issueNodes).toHaveLength(2);
      if (feature === "max_angle_zscore") expect(i.issueNodes).toHaveLength(3);
      for (const n of i.issueNodes) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(nNodes);
      }
    }
    expect(r.instances.some((i) => i.issueNodes.length > 0)).toBe(true);
  });

  it("is deterministic across runs", async () => {
    const labels = await loadFixture();
    const a = scoreLabelsAnomaly(labels).instances;
    const b = scoreLabelsAnomaly(labels).instances;
    expect(a[0].score).toBe(b[0].score);
    expect(a[70].score).toBe(b[70].score);
  });

  it("getInstances selector can restrict the scored set", async () => {
    const r = scoreLabelsAnomaly(await loadFixture(), {
      getInstances: () => [],
    });
    expect(r.instances).toHaveLength(0);
    expect(r.featureNames).toHaveLength(18);
  });

  it("scores only user instances, not predictions (PyQt parity)", () => {
    // 6 frames × (1 user + 1 predicted) = 12 instances, 6 of them user-labeled.
    // QC scores labels only (like PyQt's user_instances), so exactly 6 scored.
    const r = scoreLabelsAnomaly(mixedUserPredictedLabels(6));
    expect(r.instances).toHaveLength(6);
    // Every scored instance is the user one at instIdx 0 of its frame.
    for (const inst of r.instances) expect(inst.instIdx).toBe(0);
  });

  it("async path also scores only user instances", async () => {
    const r = await scoreLabelsAnomalyAsync(mixedUserPredictedLabels(6), {
      batchSize: 4,
    });
    expect(r.instances).toHaveLength(6);
  });

  it("caps the fit reference on large files but still scores ALL instances", async () => {
    // maxReferenceSize 10 << 140 instances -> the fit set is sampled, every
    // instance is still scored and gets a valid [0,1] score.
    const r = scoreLabelsAnomaly(await loadFixture(), {
      config: makeQCConfig({ maxReferenceSize: 10 }),
    });
    expect(r.instances).toHaveLength(140);
    expect(r.featureNames).toHaveLength(18);
    for (const inst of r.instances) {
      expect(inst.score).toBeGreaterThanOrEqual(0);
      expect(inst.score).toBeLessThanOrEqual(1);
    }
  });

  it("throws when the labels have no skeleton", () => {
    const fake = { skeletons: [], videos: [] } as unknown as Labels;
    expect(() => scoreLabelsAnomaly(fake)).toThrow();
  });
});

describe("scoreLabelsAnomalyAsync", () => {
  it("produces the SAME instances/scores as the sync version", async () => {
    const labels = await loadFixture();
    const sync = scoreLabelsAnomaly(labels);
    const async = await scoreLabelsAnomalyAsync(labels, { batchSize: 16 });
    expect(async.featureNames).toEqual(sync.featureNames);
    expect(async.instances).toHaveLength(sync.instances.length);
    for (let i = 0; i < sync.instances.length; i++) {
      expect(async.instances[i].score).toBe(sync.instances[i].score);
      expect(async.instances[i].topIssue).toBe(sync.instances[i].topIssue);
      expect(async.instances[i].frameIdx).toBe(sync.instances[i].frameIdx);
      expect(async.instances[i].gmmScore).toBe(sync.instances[i].gmmScore);
      expect(async.instances[i].gmmNode).toBe(sync.instances[i].gmmNode);
    }
    expect(async.gmmThreshold).toBe(sync.gmmThreshold);
  });

  it("reports monotonic progress ending at 1", async () => {
    const seen: number[] = [];
    await scoreLabelsAnomalyAsync(await loadFixture(), {
      batchSize: 16,
      onProgress: (f) => seen.push(f),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("aborts when the signal is already aborted", async () => {
    const labels = await loadFixture();
    const ac = new AbortController();
    ac.abort();
    let threw = false;
    try {
      await scoreLabelsAnomalyAsync(labels, { signal: ac.signal, batchSize: 16 });
    } catch (e) {
      threw = true;
      expect((e as Error).name).toBe("AbortError");
    }
    expect(threw).toBe(true);
  });
});

describe("GMM score", () => {
  it("runs with 50+ labels and flags about the least typical 5%", async () => {
    const r = scoreLabelsAnomaly(await loadFixture()); // 140 user instances
    expect(r.gmmThreshold).toBeCloseTo(0.95, 12);
    for (const inst of r.instances) {
      expect(inst.gmmScore).not.toBeNull();
      expect(inst.gmmScore as number).toBeGreaterThanOrEqual(0);
      expect(inst.gmmScore as number).toBeLessThanOrEqual(1);
    }
    const flagged = r.instances.filter((i) => (i.gmmScore as number) >= 0.95);
    // A percentile score: by construction ~5% of the 140 reference poses.
    expect(flagged.length).toBeGreaterThanOrEqual(5);
    expect(flagged.length).toBeLessThanOrEqual(9);
    for (const f of flagged) {
      expect(f.gmmIssue?.startsWith("Improbable pose")).toBe(true);
      expect(f.gmmNode).not.toBeNull();
      expect(f.gmmNode as number).toBeGreaterThanOrEqual(-1);
      expect(f.gmmNode as number).toBeLessThan(24);
    }
    for (const i of r.instances.filter((x) => (x.gmmScore as number) < 0.95)) {
      expect(i.gmmIssue).toBeNull();
      expect(i.gmmNode).toBeNull();
    }
  });

  it("is skipped below 50 labels: ZScore only", () => {
    const r = scoreLabelsAnomaly(mixedUserPredictedLabels(6)); // 6 user instances
    expect(r.gmmThreshold).toBeNull();
    for (const i of r.instances) expect(i.gmmScore).toBeNull();
  });

  it("is skipped when disabled in the config", async () => {
    const r = scoreLabelsAnomaly(await loadFixture(), { config: makeQCConfig({ useGmm: false }) });
    expect(r.gmmThreshold).toBeNull();
    expect(r.instances.every((i) => i.gmmScore === null)).toBe(true);
  });

  it("is deterministic across runs", async () => {
    const labels = await loadFixture();
    const a = scoreLabelsAnomaly(labels).instances.map((i) => i.gmmScore);
    const b = scoreLabelsAnomaly(labels).instances.map((i) => i.gmmScore);
    expect(a).toEqual(b);
  });
});

describe("anomalyVerdict", () => {
  const inst = (score: number, gmmScore: number | null): AnomalyInstance => ({
    videoIdx: 0,
    frameIdx: 0,
    instIdx: 0,
    score,
    confidence: "low",
    topIssue: "Unusual edge length",
    issueNodes: [],
    issueKind: null,
    issueDir: 0,
    contributions: {},
    gmmScore,
    gmmIssue: gmmScore != null && gmmScore >= 0.95 ? "Improbable pose · Unusual pose structure" : null,
    gmmNode: null,
  });

  it("flags on the anomaly score alone, with the anomaly explanation", () => {
    const v = anomalyVerdict(inst(0.8, 0.5), 0.7, 0.95);
    expect(v).toMatchObject({ flagged: true, by: "anomaly", issue: "Unusual edge length" });
    expect(v.score).toBe(0.8);
  });

  it("flags on the GMM alone, with the GMM explanation (the frame-4 fly case)", () => {
    const v = anomalyVerdict(inst(0.38, 0.96), 0.7, 0.95);
    expect(v).toMatchObject({ flagged: true, by: "gmm", issue: "Improbable pose · Unusual pose structure" });
    expect(v.score).toBe(0.96);
    expect(v.confidence).toBe("high");
  });

  it("uses the higher score when both flag, and the anomaly explanation", () => {
    const v = anomalyVerdict(inst(0.75, 0.99), 0.7, 0.95);
    expect(v).toMatchObject({ flagged: true, by: "both", score: 0.99, issue: "Unusual edge length" });
  });

  it("does not flag when neither clears its threshold, or when the GMM didn't run", () => {
    expect(anomalyVerdict(inst(0.5, 0.9), 0.7, 0.95)).toMatchObject({ flagged: false, by: null, score: 0.5 });
    expect(anomalyVerdict(inst(0.5, null), 0.7, null).flagged).toBe(false);
  });
});
