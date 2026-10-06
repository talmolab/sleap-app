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
  scoreLabelsAnomaly,
  scoreLabelsAnomalyAsync,
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
    }
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
