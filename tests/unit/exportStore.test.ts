import { describe, it, expect } from "../bun-test";
import {
  defaultExportOutputDir,
  logIndicatesMissingExportSupport,
  useExportStore,
} from "@/stores/exportStore";

describe("useExportStore model paths", () => {
  it("openExport([]) opens the dialog with no preset model (menu entry point)", () => {
    useExportStore.getState().openExport([]);
    expect(useExportStore.getState().open).toBe(true);
    expect(useExportStore.getState().modelPaths).toEqual([]);
  });

  it("setModelPaths replaces the run directories (in-dialog picker)", () => {
    useExportStore.getState().openExport(["/models/a"]);
    useExportStore.getState().setModelPaths(["/models/a", "/models/b"]);
    expect(useExportStore.getState().modelPaths).toEqual(["/models/a", "/models/b"]);
  });

  it("addModelPaths appends a multi-select batch to the existing dirs", () => {
    useExportStore.getState().openExport(["/models/a"]);
    // A top-down bundle: user picks both remaining run dirs in one native dialog.
    useExportStore.getState().addModelPaths(["/models/b", "/models/c"]);
    expect(useExportStore.getState().modelPaths).toEqual([
      "/models/a",
      "/models/b",
      "/models/c",
    ]);
  });

  it("addModelPaths dedupes against existing and within the incoming batch", () => {
    useExportStore.getState().openExport(["/models/a"]);
    useExportStore.getState().addModelPaths(["/models/a", "/models/b", "/models/b"]);
    expect(useExportStore.getState().modelPaths).toEqual(["/models/a", "/models/b"]);
  });
});

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
