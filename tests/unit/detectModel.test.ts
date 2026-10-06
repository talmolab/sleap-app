import { describe, it, expect } from "../bun-test";
import { detectModelHead } from "@/lib/models/detectModel";

/** Minimal sleap-nn training_config.yaml with `active` set as the one non-null head. */
function cfg(active: string, extra = ""): string {
  const heads = [
    "single_instance",
    "centroid",
    "centered_instance",
    "bottomup",
    "multi_class_bottomup",
    "multi_class_topdown",
  ];
  const body = heads
    .map((h) =>
      h === active
        ? `    ${h}:\n      confmaps:\n        sigma: 2.5\n        output_stride: 2`
        : `    ${h}: null`,
    )
    .join("\n");
  return `model_config:\n  head_configs:\n${body}\n${extra}`;
}

describe("detectModelHead", () => {
  it("detects a centroid model", () => {
    expect(detectModelHead(cfg("centroid"))).toBe("centroid");
  });

  it("detects a centered_instance model", () => {
    expect(detectModelHead(cfg("centered_instance"))).toBe("centered_instance");
  });

  it("detects a single_instance model", () => {
    expect(detectModelHead(cfg("single_instance"))).toBe("single_instance");
  });

  it("detects a bottomup model", () => {
    expect(detectModelHead(cfg("bottomup"))).toBe("bottomup");
  });

  it("returns the single non-null head even when others are explicitly null", () => {
    // Only centered_instance is non-null in cfg(); the rest are `null`.
    expect(detectModelHead(cfg("centered_instance"))).toBe("centered_instance");
  });

  it("returns null when every head is null", () => {
    const allNull =
      "model_config:\n  head_configs:\n" +
      "    single_instance: null\n    centroid: null\n    centered_instance: null\n" +
      "    bottomup: null\n    multi_class_bottomup: null\n    multi_class_topdown: null";
    expect(detectModelHead(allNull)).toBeNull();
  });

  it("returns null when head_configs is missing", () => {
    expect(detectModelHead("model_config:\n  backbone_config:\n    unet:\n      filters: 16")).toBeNull();
  });

  it("returns null when model_config is missing", () => {
    expect(detectModelHead("data_config:\n  validation_fraction: 0.1")).toBeNull();
  });

  it("returns null on malformed yaml", () => {
    expect(detectModelHead("model_config: {: : :")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(detectModelHead("")).toBeNull();
  });
});
