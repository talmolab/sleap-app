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
import { loadSlp } from "@talmolab/sleap-io.js";
import { scoreLabelsAnomaly } from "@/lib/analyze/qc/anomaly";
import type { Labels } from "@/types";

const loadFixture = async () =>
  loadSlp(await Bun.file("tests/fixtures/centered_pair.slp").arrayBuffer(), {
    openVideos: false,
  });

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

  it("throws when the labels have no skeleton", () => {
    const fake = { skeletons: [], videos: [] } as unknown as Labels;
    expect(() => scoreLabelsAnomaly(fake)).toThrow();
  });
});
