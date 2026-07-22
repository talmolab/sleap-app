/**
 * Tests for the active-learning config core (issue #212, M0).
 */

import { describe, it, expect } from "../bun-test";
import {
  ACTIVE_LEARNING_CONFIG_VERSION,
  DEFAULT_ACTIVE_LEARNING_CONFIG,
  parseActiveLearningConfig,
  serializeActiveLearningConfig,
  normalizeActiveLearningConfig,
  validateActiveLearningConfig,
  allPassNodes,
  configFromSkeleton,
  pickCentroidNode,
  type ActiveLearningConfig,
} from "@/lib/activeLearning/config";

/** Node names that cover the default rodent config (centroid + all passes). */
const DEFAULT_SKELETON_NODES = [
  "body_center",
  "tti",
  "trunk",
  "neck",
  "head",
  "nose",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_haunch",
  "right_haunch",
  "tail_base",
  "tail_mid",
  "tail_tip",
];

describe("active-learning config", () => {
  it("default config validates against a matching skeleton", () => {
    const result = validateActiveLearningConfig(
      DEFAULT_ACTIVE_LEARNING_CONFIG,
      DEFAULT_SKELETON_NODES,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("round-trips through serialize → parse", () => {
    const yamlText = serializeActiveLearningConfig(DEFAULT_ACTIVE_LEARNING_CONFIG);
    const parsed = parseActiveLearningConfig(yamlText);
    expect(parsed).toEqual(DEFAULT_ACTIVE_LEARNING_CONFIG);
  });

  it("merges a partial YAML with defaults", () => {
    const parsed = parseActiveLearningConfig("loop:\n  maxRounds: 3\n");
    expect(parsed.loop.maxRounds).toBe(3);
    // Untouched fields fall back to defaults.
    expect(parsed.loop.stopWhen.metricPlateau).toBe(
      DEFAULT_ACTIVE_LEARNING_CONFIG.loop.stopWhen.metricPlateau,
    );
    expect(parsed.labelKeypoints.passes).toEqual(
      DEFAULT_ACTIVE_LEARNING_CONFIG.labelKeypoints.passes,
    );
    expect(parsed.consistency).toEqual(DEFAULT_ACTIVE_LEARNING_CONFIG.consistency);
  });

  it("replaces passes wholesale when provided", () => {
    const parsed = parseActiveLearningConfig(
      "labelKeypoints:\n  passes:\n    - { name: Only, nodes: [a, b] }\n",
    );
    expect(parsed.labelKeypoints.passes).toEqual([
      { name: "Only", nodes: ["a", "b"], axis: false },
    ]);
    expect(allPassNodes(parsed)).toEqual(["a", "b"]);
  });

  it("coerces numeric strings and defaults the axis flag to false", () => {
    const parsed = parseActiveLearningConfig(
      "loop:\n  maxRounds: '4'\nlabelKeypoints:\n  passes:\n    - { name: P, nodes: [x] }\n",
    );
    expect(parsed.loop.maxRounds).toBe(4);
    expect(parsed.labelKeypoints.passes[0].axis).toBe(false);
  });

  it("maps the legacy per-pass guide:axis onto the axis flag", () => {
    const parsed = parseActiveLearningConfig(
      "labelKeypoints:\n  passes:\n    - { name: A, nodes: [x, y], guide: axis }\n    - { name: B, nodes: [z] }\n",
    );
    expect(parsed.labelKeypoints.passes[0].axis).toBe(true);
    expect(parsed.labelKeypoints.passes[1].axis).toBe(false);
  });

  it("keeps at most one axis pass (first wins)", () => {
    const parsed = parseActiveLearningConfig(
      "labelKeypoints:\n  passes:\n    - { name: A, nodes: [a, b], axis: true }\n    - { name: B, nodes: [c, d], axis: true }\n",
    );
    expect(parsed.labelKeypoints.passes.map((p) => p.axis)).toEqual([true, false]);
  });

  it("filters unknown mining strategies and bad pass order", () => {
    const parsed = parseActiveLearningConfig(
      "labelKeypoints:\n  order: sideways\nmine:\n  strategies: [prediction_score, nonsense]\n",
    );
    expect(parsed.labelKeypoints.order).toBe("pass-major");
    expect(parsed.mine.strategies).toEqual(["prediction_score"]);
  });

  it("flags pass nodes and centroid node missing from the skeleton", () => {
    const result = validateActiveLearningConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, [
      "body_center",
      "tti",
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('"trunk"'))).toBe(true);
  });

  it("warns about skeleton nodes not covered by any pass", () => {
    const result = validateActiveLearningConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, [
      ...DEFAULT_SKELETON_NODES,
      "extra_toe",
    ]);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("extra_toe"))).toBe(true);
  });

  it("warns about a node appearing in more than one pass", () => {
    const cfg: ActiveLearningConfig = normalizeActiveLearningConfig({
      labelKeypoints: {
        passes: [
          { name: "A", nodes: ["shared"] },
          { name: "B", nodes: ["shared"] },
        ],
      },
    });
    const result = validateActiveLearningConfig(cfg);
    expect(result.warnings.some((w) => w.includes('"shared"'))).toBe(true);
  });

  it("picks a central-body node as the centroid, else the first node", () => {
    // Real als2h skeleton node names.
    const als2h = [
      "Nose", "Head", "Ear_L", "Shoulder_left", "Neck", "Ear_R", "Shoulder_right",
      "Haunch_left", "Haunch_right", "Tail_1", "Tail_0", "TTI", "Tail_2", "TailTip", "Trunk",
    ];
    expect(pickCentroidNode(als2h)).toBe("Trunk");
    expect(pickCentroidNode(["p0", "p1", "p2"])).toBe("p0");
    expect(pickCentroidNode([])).toBe("");
  });

  it("builds a valid one-pass starter config from skeleton node names", () => {
    const nodes = ["Nose", "Head", "TTI", "Trunk", "TailTip"];
    const cfg = configFromSkeleton(nodes);
    expect(cfg.labelKeypoints.passes).toHaveLength(1);
    expect(cfg.labelKeypoints.passes[0].nodes).toEqual(nodes);
    expect(cfg.localize.centroidNode).toBe("Trunk");
    // Every node is covered and the centroid is real → clean validation.
    const result = validateActiveLearningConfig(cfg, nodes);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("has locator training defaults (fast preset, minimal aug)", () => {
    const t = DEFAULT_ACTIVE_LEARNING_CONFIG.localize;
    expect(t.trainAfter).toBe(100);
    expect(t.training.backbone).toBe("unet");
    expect(t.training.inputScale).toBe(0.5);
    expect(t.training.augmentation).toBe("minimal");
    expect(t.training.earlyStop).toBe(true);
  });

  it("merges a partial training block and coerces a bad backbone", () => {
    const parsed = parseActiveLearningConfig(
      "localize:\n  trainAfter: 150\n  training:\n    maxEpochs: 50\n    backbone: bogus\n",
    );
    expect(parsed.localize.trainAfter).toBe(150);
    expect(parsed.localize.training.maxEpochs).toBe(50);
    // Bad backbone falls back to default; untouched fields keep defaults.
    expect(parsed.localize.training.backbone).toBe("unet");
    expect(parsed.localize.training.inputScale).toBe(0.5);
  });

  it("errors on bad locator training params", () => {
    const cfg: ActiveLearningConfig = {
      ...DEFAULT_ACTIVE_LEARNING_CONFIG,
      localize: {
        ...DEFAULT_ACTIVE_LEARNING_CONFIG.localize,
        trainAfter: 0,
        training: {
          ...DEFAULT_ACTIVE_LEARNING_CONFIG.localize.training,
          inputScale: 2,
          maxEpochs: 0,
          batchSize: 0,
        },
      },
    };
    const result = validateActiveLearningConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("errors on empty passes, bad fraction, low maxRounds, and future version", () => {
    const cfg: ActiveLearningConfig = {
      ...DEFAULT_ACTIVE_LEARNING_CONFIG,
      version: ACTIVE_LEARNING_CONFIG_VERSION + 1,
      loop: { maxRounds: 0, stopWhen: { metricPlateau: false } },
      labelKeypoints: { order: "pass-major", passes: [] },
      consistency: { enabled: true, fraction: 1.5, blind: true },
    };
    const result = validateActiveLearningConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});
