/**
 * Regression test for the "silent training start" bug (issue #212).
 *
 * The bug: startCentroidLocatorTraining reported "training started" even when
 * training couldn't run (no desktop app / no sleap-nn), leaving the user to
 * believe a run was underway. It must NOT kick off a run or claim success when
 * the runtime can't support it. In the unit environment `isTauri` is false, so
 * the desktop precheck fails and no run should start.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { startCentroidLocatorTraining } from "@/lib/activeLearning/trainLocator";
import { DEFAULT_ACTIVE_LEARNING_CONFIG } from "@/lib/activeLearning/config";
import { useTrainingStore } from "@/stores/trainingStore";

describe("startCentroidLocatorTraining precheck", () => {
  beforeEach(() => {
    useTrainingStore.getState().reset();
  });

  it("returns false and starts nothing when the runtime can't train", () => {
    const started = startCentroidLocatorTraining(DEFAULT_ACTIVE_LEARNING_CONFIG);
    // Not desktop in the unit env → precheck fails, no run kicked off.
    expect(started).toBe(false);
    // Crucially, status stays idle (no false "running"/"started").
    expect(useTrainingStore.getState().status).toBe("idle");
  });
});
