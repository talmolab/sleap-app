/**
 * In-app model exporter — convert a trained model to ONNX / TensorRT for faster
 * inference. Driven by {@link useExportStore}; streams `sleap-nn export` progress
 * live. If the sleap-nn `[export]` extra isn't installed (onnxruntime missing),
 * the run fails with an import error and this dialog offers a one-click
 * on-demand install (+ retry). TensorRT is offered only on CUDA hosts.
 *
 * Rendered once near the app root (AppShell); `useExportStore.openExport(dirs)`
 * surfaces it for a given trained-model run directory (two dirs for a top-down
 * bundle: centroid + centered_instance).
 */

import { useEffect, useRef, useState } from "react";
import { useExportStore, logIndicatesMissingExportSupport } from "@/stores/exportStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { detectGpu } from "@/platform/backend";
import { isTauri } from "@/platform/index";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ExportFormat, ExportPrecision } from "@/platform/exportArgs";

export function ExportModelDialog() {
  const open = useExportStore((s) => s.open);
  const status = useExportStore((s) => s.status);
  const log = useExportStore((s) => s.log);
  const outputDir = useExportStore((s) => s.outputDir);
  const modelPaths = useExportStore((s) => s.modelPaths);
  const close = useExportStore((s) => s.close);
  const startExport = useExportStore((s) => s.startExport);

  const installStatus = useEnvironmentStore((s) => s.installStatus);
  const installLog = useEnvironmentStore((s) => s.installLog);
  const installExportExtra = useEnvironmentStore((s) => s.installExportExtra);

  const [format, setFormat] = useState<ExportFormat>("onnx");
  const [precision, setPrecision] = useState<ExportPrecision>("fp16");
  const [gpuBackend, setGpuBackend] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (isTauri) detectGpu().then(setGpuBackend).catch(() => setGpuBackend(null));
  }, []);

  // Auto-scroll the log to the bottom as lines stream in.
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log, installLog]);

  const trtAvailable = gpuBackend === "cuda"; // TensorRT is NVIDIA/Linux/Windows only
  const installing = installStatus === "installing";
  const busy = status === "exporting" || installing;
  const missingSupport = status === "error" && logIndicatesMissingExportSupport(log);
  const shownLog = installing ? installLog : log;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export model</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Convert the trained model to a portable runtime for faster inference.
            {modelPaths.length > 1
              ? " Top-down bundle (centroid + centered-instance) exported together."
              : ""}
          </p>

          <div className="flex items-center gap-3">
            <span className="w-20 text-sm">Format</span>
            <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)} disabled={busy}>
              <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="onnx">ONNX</SelectItem>
                {trtAvailable && <SelectItem value="tensorrt">TensorRT</SelectItem>}
                {trtAvailable && <SelectItem value="both">Both</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          {format !== "onnx" && (
            <div className="flex items-center gap-3">
              <span className="w-20 text-sm">Precision</span>
              <Select value={precision} onValueChange={(v) => setPrecision(v as ExportPrecision)} disabled={busy}>
                <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fp16">fp16</SelectItem>
                  <SelectItem value="fp32">fp32</SelectItem>
                  <SelectItem value="tf32">tf32</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {shownLog.length > 0 && (
            <pre
              ref={logRef}
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]"
            >
              {shownLog.join("\n")}
            </pre>
          )}

          {status === "done" && (
            <p className="text-sm text-green-500">Exported to {outputDir}</p>
          )}

          {missingSupport && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-amber-500">
              <span>ONNX/TensorRT support isn't installed in the sleap-nn environment.</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  await installExportExtra(format !== "onnx" && trtAvailable);
                  await startExport(format, precision);
                }}
              >
                Install support &amp; retry
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {status === "done" ? "Close" : "Cancel"}
            </Button>
            <Button onClick={() => startExport(format, precision)} disabled={busy || modelPaths.length === 0}>
              {status === "exporting" ? "Exporting…" : installing ? "Installing…" : "Export"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
