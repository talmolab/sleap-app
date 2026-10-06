/**
 * Pure builder for the `sleap-nn export` CLI argv (exporting a trained model to
 * ONNX / TensorRT).
 *
 * Kept free of any Tauri / store imports so it is unit-testable in isolation
 * (see tests/unit/exportArgs.test.ts). `runExport` in ./backend.ts delegates the
 * argv assembly here — mirroring the buildTrainingArgs / buildInferenceArgs
 * split. Unlike `train` (Hydra), `export` is a plain click command, so values
 * are passed as ordinary flags with no Hydra quoting.
 *
 * CLI shape (sleap-nn export): `export MODEL_DIRS... --output <dir> --format
 * onnx|tensorrt|both [--precision fp32|fp16|tf32]`. MODEL_DIRS are positional
 * and must come first; a top-down model is exported by passing BOTH run dirs
 * (centroid + centered_instance) together.
 */

export type ExportFormat = "onnx" | "tensorrt" | "both";
export type ExportPrecision = "fp32" | "fp16" | "tf32";

export interface BuildExportArgsOptions {
  /** Trained-model run DIRECTORIES to export (one, or two for a top-down bundle). */
  modelPaths: string[];
  /** Output directory for the exported model (model.onnx / model.trt). */
  outputDir: string;
  /** Target format. */
  format: ExportFormat;
  /**
   * TensorRT build precision. Only emitted for tensorrt/both (ONNX export
   * ignores it), so an ONNX-only run stays flag-clean. Defaults to fp16.
   */
  precision?: ExportPrecision;
}

/**
 * Build the full `sleap-nn export ...` argv (excluding the `sleap-nn` program
 * token itself). Model dirs are positional and emitted first.
 */
export function buildExportArgs({
  modelPaths,
  outputDir,
  format,
  precision = "fp16",
}: BuildExportArgsOptions): string[] {
  const args = ["export", ...modelPaths, "--output", outputDir, "--format", format];
  // --precision is a TensorRT build knob; ONNX export ignores it.
  if (format !== "onnx") {
    args.push("--precision", precision);
  }
  return args;
}
