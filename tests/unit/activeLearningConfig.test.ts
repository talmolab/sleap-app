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
      { name: "Only", nodes: ["a", "b"], guide: "none" },
    ]);
    expect(allPassNodes(parsed)).toEqual(["a", "b"]);
  });

  it("coerces numeric strings and defaults an out-of-set guide", () => {
    const parsed = parseActiveLearningConfig(
      "loop:\n  maxRounds: '4'\nlabelKeypoints:\n  passes:\n    - { name: P, nodes: [x], guide: bogus }\n",
    );
    expect(parsed.loop.maxRounds).toBe(4);
    expect(parsed.labelKeypoints.passes[0].guide).toBe("none");
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
