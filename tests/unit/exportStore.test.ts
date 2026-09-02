import { describe, it, expect } from "../bun-test";
import {
  defaultExportOutputDir,
  logIndicatesMissingExportSupport,
} from "@/stores/exportStore";

describe("defaultExportOutputDir", () => {
  it("places the exported bundle in the run dirs' PARENT, not under one run", () => {
    expect(defaultExportOutputDir(["/models/run1"])).toBe("/models/exported");
  });

  it("strips a trailing slash before deriving the parent", () => {
    expect(defaultExportOutputDir(["/models/run1/"])).toBe("/models/exported");
  });

  it("is neutral for a top-down bundle — not nested under the centroid run", () => {
    expect(defaultExportOutputDir(["/models/centroid", "/models/centered"])).toBe(
      "/models/exported",
    );
  });

  it("falls back to <dir>/exported when there is no parent segment", () => {
    expect(defaultExportOutputDir(["run1"])).toBe("run1/exported");
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
