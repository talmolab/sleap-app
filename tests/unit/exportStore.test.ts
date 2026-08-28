import { describe, it, expect } from "../bun-test";
import {
  defaultExportOutputDir,
  logIndicatesMissingExportSupport,
} from "@/stores/exportStore";

describe("defaultExportOutputDir", () => {
  it("appends /exported to the first model dir", () => {
    expect(defaultExportOutputDir(["/models/run1"])).toBe("/models/run1/exported");
  });

  it("strips a trailing slash before appending", () => {
    expect(defaultExportOutputDir(["/models/run1/"])).toBe("/models/run1/exported");
  });

  it("uses the FIRST dir for a top-down bundle (centroid + centered_instance)", () => {
    expect(defaultExportOutputDir(["/models/centroid", "/models/centered"])).toBe(
      "/models/centroid/exported",
    );
  });
});

describe("logIndicatesMissingExportSupport", () => {
  it("detects a missing onnxruntime module", () => {
    expect(
      logIndicatesMissingExportSupport(["ModuleNotFoundError: No module named 'onnxruntime'"]),
    ).toBe(true);
  });

  it("detects a missing onnx module", () => {
    expect(logIndicatesMissingExportSupport(["No module named onnx"])).toBe(true);
  });

  it("is false for a normal successful export log", () => {
    expect(
      logIndicatesMissingExportSupport([
        "Exporting model to ONNX...",
        "Wrote model.onnx",
        "Done.",
      ]),
    ).toBe(false);
  });
});
