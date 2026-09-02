/**
 * Drives the in-app model exporter (Export to ONNX / TensorRT). A single export
 * runs at a time; the ExportModelDialog subscribes to this store for its open
 * state, the streaming log, and status. Mirrors the streaming-store shape used
 * by environmentStore's install flow (accumulate log lines from ProcessEvents,
 * flip status on `finished`).
 */

import { create } from "zustand";
import { runExport } from "@/platform/backend";
import type { ExportFormat, ExportPrecision } from "@/platform/exportArgs";

export type ExportStatus = "idle" | "exporting" | "done" | "error";

interface ExportState {
  open: boolean;
  /** Run directories to export: one, or two for a top-down bundle (centroid + centered_instance). */
  modelPaths: string[];
  status: ExportStatus;
  log: string[];
  /** Where the exported model was/will be written (<first model dir>/exported). */
  outputDir: string | null;
  openExport: (modelPaths: string[]) => void;
  close: () => void;
  startExport: (format: ExportFormat, precision: ExportPrecision) => Promise<void>;
}

/**
 * Default export output dir: `<run dirs' parent>/exported` (e.g. `models/exported`).
 * A top-down export bundles BOTH heads (centroid + centered_instance) into a single
 * `model.onnx`, so nesting it under the first (centroid) run dir read as "centroid
 * only". Placing it in the parent keeps it neutral. Falls back to `<dir>/exported`
 * when the first path has no parent segment.
 */
export function defaultExportOutputDir(modelPaths: string[]): string {
  const first = (modelPaths[0] ?? "").replace(/[/\\]+$/, "");
  const parent = first.replace(/[/\\][^/\\]+$/, "");
  return `${parent && parent !== first ? parent : first}/exported`;
}

/** True if the export log shows onnx/onnxruntime is missing (the [export] extra isn't installed). */
export function logIndicatesMissingExportSupport(log: string[]): boolean {
  return log.some((line) =>
    /ModuleNotFoundError|No module named ['"]?(onnx|onnxruntime|tensorrt)/i.test(line),
  );
}

export const useExportStore = create<ExportState>((set, get) => ({
  open: false,
  modelPaths: [],
  status: "idle",
  log: [],
  outputDir: null,

  openExport: (modelPaths) =>
    set({ open: true, modelPaths, status: "idle", log: [], outputDir: null }),

  close: () => set({ open: false }),

  startExport: async (format, precision) => {
    const { modelPaths } = get();
    if (modelPaths.length === 0) return;
    const outputDir = defaultExportOutputDir(modelPaths);
    set({ status: "exporting", log: [], outputDir });

    const result = await runExport({ modelPaths, outputDir, format, precision }, (event) => {
      if (event.event === "stdout" || event.event === "stderr") {
        set((s) => ({ log: [...s.log, event.data.line] }));
      } else if (event.event === "finished") {
        set({ status: event.data.success ? "done" : "error" });
      }
    });

    // Guard against a missing `finished` event (or the non-Tauri no-op path).
    set((s) => (s.status === "exporting" ? { status: result.success ? "done" : "error" } : {}));
  },
}));
