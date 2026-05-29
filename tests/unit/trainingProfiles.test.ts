import { describe, it, expect } from "../bun-test";
import {
  BASELINE_PROFILES,
  getBaselineProfilesForHead,
  getDefaultProfileForHead,
  slotToHeadType,
} from "@/lib/trainingProfiles";

describe("trainingProfiles", () => {
  it("has 9 baseline profiles", () => {
    expect(BASELINE_PROFILES).toHaveLength(9);
  });

  it("returns correct profiles for centroid", () => {
    const profiles = getBaselineProfilesForHead("centroid");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].filename).toBe("baseline.centroid.yaml");
  });

  it("returns correct profiles for centered_instance", () => {
    const profiles = getBaselineProfilesForHead("centered_instance");
    expect(profiles).toHaveLength(2);
    expect(profiles[0].filename).toContain("medium_rf");
    expect(profiles[1].filename).toContain("large_rf");
  });

  it("returns correct profiles for bottomup", () => {
    expect(getBaselineProfilesForHead("bottomup")).toHaveLength(2);
  });

  it("returns correct profiles for single_instance", () => {
    expect(getBaselineProfilesForHead("single_instance")).toHaveLength(2);
  });

  it("returns correct profiles for multi_class_bottomup", () => {
    const profiles = getBaselineProfilesForHead("multi_class_bottomup");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].filename).toBe("baseline.multi_class_bottomup.yaml");
  });

  it("returns correct profiles for multi_class_topdown", () => {
    const profiles = getBaselineProfilesForHead("multi_class_topdown");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].filename).toBe("baseline.multi_class_topdown.yaml");
  });

  it("returns default profile for centroid", () => {
    const p = getDefaultProfileForHead("centroid");
    expect(p).toBeDefined();
    expect(p!.filename).toBe("baseline.centroid.yaml");
  });

  it("returns undefined for unknown head type", () => {
    expect(getDefaultProfileForHead("nonexistent")).toBeUndefined();
  });

  it("all profiles have non-empty content", () => {
    for (const p of BASELINE_PROFILES) {
      expect(p.content.length).toBeGreaterThan(100);
    }
  });

  describe("slotToHeadType", () => {
    it("maps centroid slot directly", () => {
      expect(slotToHeadType("top_down", "centroid")).toBe("centroid");
    });

    it("maps centered_instance slot directly", () => {
      expect(slotToHeadType("top_down", "centered_instance")).toBe("centered_instance");
    });

    it("maps config slot for single_animal to single_instance", () => {
      expect(slotToHeadType("single_animal", "config")).toBe("single_instance");
    });

    it("maps config slot for bottom_up to bottomup", () => {
      expect(slotToHeadType("bottom_up", "config")).toBe("bottomup");
    });

    it("maps config slot for bottom_up_id to multi_class_bottomup", () => {
      expect(slotToHeadType("bottom_up_id", "config")).toBe("multi_class_bottomup");
    });

    it("maps config slot for top_down_id to multi_class_topdown", () => {
      expect(slotToHeadType("top_down_id", "config")).toBe("multi_class_topdown");
    });
  });
});
