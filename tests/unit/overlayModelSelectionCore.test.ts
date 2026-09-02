import { describe, it, expect } from "../bun-test";
import {
  PIPELINE_SLOTS,
  slotOptions,
  headTypeLabel,
  slotLabel,
  validateSelection,
  resolveModelPaths,
  rejectReason,
  type ModelCatalogEntry,
} from "@/lib/models/overlayModelSelectionCore";

const CATALOG: ModelCatalogEntry[] = [
  { path: "/m/260428.centroid.n=2560", runName: "260428.centroid.n=2560", head: "centroid" },
  { path: "/m/260130.centroid.n=1", runName: "260130.centroid.n=1", head: "centroid" },
  {
    path: "/m/260428.centered_instance.n=2560",
    runName: "260428.centered_instance.n=2560",
    head: "centered_instance",
  },
  { path: "/m/260501.single.n=200", runName: "260501.single.n=200", head: "single_instance" },
];

describe("PIPELINE_SLOTS", () => {
  it("top-down needs centroid + centered_instance (in order)", () => {
    expect(PIPELINE_SLOTS["top-down"]).toEqual(["centroid", "centered_instance"]);
  });
  it("single-animal needs one single_instance slot", () => {
    expect(PIPELINE_SLOTS["single-animal"]).toEqual(["single_instance"]);
  });
  it("bottom-up needs one bottomup slot", () => {
    expect(PIPELINE_SLOTS["bottom-up"]).toEqual(["bottomup"]);
  });
});

describe("slotOptions", () => {
  it("returns only catalog entries whose head matches the slot", () => {
    const centroids = slotOptions(CATALOG, "centroid");
    expect(centroids.map((e) => e.runName)).toEqual([
      "260428.centroid.n=2560",
      "260130.centroid.n=1",
    ]);
    expect(slotOptions(CATALOG, "centered_instance")).toHaveLength(1);
    expect(slotOptions(CATALOG, "single_instance")).toHaveLength(1);
  });
  it("returns [] when nothing matches", () => {
    expect(slotOptions(CATALOG, "bottomup")).toEqual([]);
  });
});

describe("headTypeLabel / slotLabel", () => {
  it("labels each known head", () => {
    expect(headTypeLabel("centroid")).toBe("centroid");
    expect(headTypeLabel("centered_instance")).toBe("centered-instance");
    expect(headTypeLabel("single_instance")).toBe("single-animal");
    expect(headTypeLabel("bottomup")).toBe("bottom-up");
  });
  it("slotLabel is the capitalized head + ' model'", () => {
    expect(slotLabel("centroid")).toBe("Centroid model");
    expect(slotLabel("centered_instance")).toBe("Centered-instance model");
    expect(slotLabel("single_instance")).toBe("Single-animal model");
  });
});

describe("validateSelection", () => {
  it("top-down is incomplete with only the centroid filled", () => {
    const r = validateSelection("top-down", { centroid: "/m/c" });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["centered_instance"]);
  });
  it("top-down is complete when both slots are filled", () => {
    const r = validateSelection("top-down", { centroid: "/m/c", centered_instance: "/m/ci" });
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("single-animal is complete with its one slot filled", () => {
    expect(validateSelection("single-animal", { single_instance: "/m/s" }).complete).toBe(true);
  });
  it("single-animal is incomplete when empty", () => {
    const r = validateSelection("single-animal", {});
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["single_instance"]);
  });
  it("treats an empty-string path as unfilled", () => {
    expect(validateSelection("single-animal", { single_instance: "" }).complete).toBe(false);
  });
});

describe("resolveModelPaths", () => {
  it("returns filled slot paths in slot order", () => {
    const paths = resolveModelPaths("top-down", {
      centered_instance: "/m/ci",
      centroid: "/m/c",
    });
    expect(paths).toEqual(["/m/c", "/m/ci"]); // centroid first, per PIPELINE_SLOTS order
  });
  it("drops unfilled slots", () => {
    expect(resolveModelPaths("top-down", { centroid: "/m/c" })).toEqual(["/m/c"]);
  });
});

describe("rejectReason", () => {
  it("returns null when the folder's head matches the slot", () => {
    expect(rejectReason("centroid", "centroid")).toBeNull();
  });
  it("explains a head mismatch in plain language", () => {
    expect(rejectReason("centered_instance", "centroid")).toBe(
      "That's a centroid model; this slot needs a centered-instance model.",
    );
  });
  it("explains an undetectable folder", () => {
    expect(rejectReason("centroid", null)).toBe("Couldn't detect a model type in that folder.");
  });
});
