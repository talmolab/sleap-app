/**
 * Unit tests for persisting the active-learning workflow inside the `.slp`
 * project (via labels provenance). See src/lib/activeLearning/persistence.ts.
 *
 * The round-trip test serializes through the sleap-io.js dict codec
 * (`toDict`/`fromDict`) rather than a real HDF5 write, which needs no wasm and
 * still exercises the exact `/metadata` provenance path that `saveSlpToBytes` /
 * `loadSlp` use.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { Labels, Skeleton, fromDict } from "@talmolab/sleap-io.js";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import {
  AL_PROVENANCE_KEY,
  writeActiveLearningToProvenance,
  syncActiveLearningProvenance,
  hydrateActiveLearningStore,
} from "@/lib/activeLearning/persistence";
import {
  DEFAULT_ACTIVE_LEARNING_CONFIG,
  configFromSkeleton,
  normalizeActiveLearningConfig,
} from "@/lib/activeLearning/config";

function labelsWith(nodeNames: string[]): Labels {
  const skeleton = new Skeleton({ nodes: nodeNames, name: "pose" });
  return new Labels({ videos: [], skeletons: [skeleton] });
}

describe("active-learning persistence (config in .slp provenance)", () => {
  beforeEach(() => {
    useActiveLearningStore.setState(useActiveLearningStore.getInitialState());
  });

  it("writes the config under the provenance key; null clears it", () => {
    const labels = labelsWith(["head", "tail"]);
    writeActiveLearningToProvenance(labels, configFromSkeleton(["head", "tail"]));
    expect(labels.provenance[AL_PROVENANCE_KEY]).toBeDefined();

    writeActiveLearningToProvenance(labels, null);
    expect(labels.provenance[AL_PROVENANCE_KEY]).toBeUndefined();
  });

  it("round-trips the workflow through the SLP dict codec", () => {
    // Adopt a non-default config in the store.
    const config = configFromSkeleton(["head", "tail"]);
    config.loop.maxRounds = 7;
    config.localize.cropSize = 321;
    useActiveLearningStore.getState().setConfig(config, ["head", "tail"]);

    // Save side: mirror store → provenance, then serialize + deserialize.
    const labels = labelsWith(["head", "tail"]);
    syncActiveLearningProvenance(labels);
    const roundTripped = fromDict(labels.toDict());

    // Load side: clear the store, then hydrate from the reloaded labels.
    useActiveLearningStore.getState().clear();
    expect(useActiveLearningStore.getState().config).toBeNull();
    hydrateActiveLearningStore(roundTripped);

    const restored = useActiveLearningStore.getState().config;
    expect(restored).not.toBeNull();
    expect(restored!.loop.maxRounds).toBe(7);
    expect(restored!.localize.cropSize).toBe(321);
    // Full structural match against the normalized original (hydrate normalizes).
    expect(restored).toEqual(normalizeActiveLearningConfig(config));
  });

  it("hydrate clears the store when the project has no workflow", () => {
    useActiveLearningStore.getState().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);
    expect(useActiveLearningStore.getState().config).not.toBeNull();

    hydrateActiveLearningStore(labelsWith(["a"]));
    expect(useActiveLearningStore.getState().config).toBeNull();
  });

  it("hydrate treats malformed provenance as no workflow (clears, no throw)", () => {
    const labels = labelsWith(["a"]);
    labels.provenance[AL_PROVENANCE_KEY] = 42; // not an object
    useActiveLearningStore.getState().setConfig(DEFAULT_ACTIVE_LEARNING_CONFIG, []);

    hydrateActiveLearningStore(labels);
    expect(useActiveLearningStore.getState().config).toBeNull();
  });
});
