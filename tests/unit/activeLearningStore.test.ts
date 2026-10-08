/**
 * Tests for the active-learning store (issue #212, M0/backbone).
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import { DEFAULT_ACTIVE_LEARNING_CONFIG } from "@/lib/activeLearning/config";

const NODES = [
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

describe("active-learning store", () => {
  beforeEach(() => {
    useActiveLearningStore.getState().clear();
  });

  it("starts idle with no config", () => {
    const s = useActiveLearningStore.getState();
    expect(s.config).toBeNull();
    expect(s.phase).toBeNull();
    expect(s.round).toBe(1);
  });

  it("adopts the default config and starts in the localize phase", () => {
    const validation = useActiveLearningStore.getState().useDefaultConfig(NODES);
    expect(validation.ok).toBe(true);
    const s = useActiveLearningStore.getState();
    expect(s.config).toBe(DEFAULT_ACTIVE_LEARNING_CONFIG);
    expect(s.phase).toBe("localize");
    expect(s.round).toBe(1);
  });

  it("loads a partial YAML workflow", () => {
    useActiveLearningStore.getState().loadConfigFromYaml("loop:\n  maxRounds: 2\n", NODES);
    expect(useActiveLearningStore.getState().config?.loop.maxRounds).toBe(2);
  });

  it("skips localize when disabled and starts in labelKeypoints", () => {
    const cfg = {
      ...DEFAULT_ACTIVE_LEARNING_CONFIG,
      localize: { ...DEFAULT_ACTIVE_LEARNING_CONFIG.localize, enabled: false },
    };
    useActiveLearningStore.getState().setConfig(cfg, NODES);
    expect(useActiveLearningStore.getState().phase).toBe("labelKeypoints");
  });

  it("adopts the config even when validation fails, exposing the errors", () => {
    const validation = useActiveLearningStore
      .getState()
      .useDefaultConfig(["body_center", "tti"]);
    expect(validation.ok).toBe(false);
    // Config is still adopted so the UI can surface the errors and let the user fix them.
    expect(useActiveLearningStore.getState().config).not.toBeNull();
    expect(useActiveLearningStore.getState().validation?.ok).toBe(false);
  });

  it("advances rounds and resets to the first enabled phase", () => {
    useActiveLearningStore.getState().useDefaultConfig(NODES);
    useActiveLearningStore.getState().setPhase("mine");
    useActiveLearningStore.getState().nextRound();
    const s = useActiveLearningStore.getState();
    expect(s.round).toBe(2);
    expect(s.phase).toBe("localize");
  });

  it("clears back to idle", () => {
    useActiveLearningStore.getState().useDefaultConfig(NODES);
    useActiveLearningStore.getState().clear();
    const s = useActiveLearningStore.getState();
    expect(s.config).toBeNull();
    expect(s.phase).toBeNull();
    expect(s.round).toBe(1);
  });
});
