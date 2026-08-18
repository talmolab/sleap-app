/**
 * "Metrics for Trained Models" table (parity with classic SLEAP
 * `MetricsTableDialog`, sleap/gui/dialogs/metrics.py:21-155).
 *
 * Seeds rows from the given run directories (typically
 * `useTrainingStore.modelOutputDirs`, i.e. models trained this session), plus
 * an auto-scan of the current project's `models/` folder on open (see
 * `findTrainedModels` — same scan `InferencePanel` uses to auto-select a
 * model), loads each model's metrics + config, and shows a sortable-ish
 * table. "Add Trained Model(s)…" appends more run dirs via the Tauri
 * directory picker. Clicking a row opens the detailed metrics dialog.
 *
 * Training/metrics are desktop-only: in the browser the loader can't read the
 * filesystem, so rows load with empty (—) metrics cells and the Add button is
 * a no-op (the directory picker throws and is swallowed).
 */

import { useEffect, useMemo, useState } from "react";
import { FolderPlus, Loader2, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { buildModelMetricsRow, runDirName } from "@/lib/metrics/loadModelMetrics";
import type { ModelMetricsRow } from "@/lib/metrics/types";
import { DetailedModelMetricsDialog } from "@/components/dialogs/DetailedModelMetricsDialog";
import { findTrainedModels } from "@/lib/modelDiscovery";
import { useAppStore } from "@/stores/appStore";

function fmt(v: number | null | undefined, digits = 4): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

const COLUMNS = [
  "Path",
  "Timestamp",
  "Model Type",
  "Architecture",
  "OKS mAP",
  "Vis Precision",
  "Vis Recall",
  "Dist 95%",
  "Dist 75%",
  "Dist Avg",
] as const;

export interface ModelMetricsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Run directories to seed the table with (e.g. modelOutputDirs). */
  runDirs: string[];
  /** Injectable row builder (defaults to the real fs-backed loader; for tests). */
  buildRow?: (runDir: string) => Promise<ModelMetricsRow>;
}

export function ModelMetricsDialog({
  open,
  onOpenChange,
  runDirs,
  buildRow,
}: ModelMetricsDialogProps) {
  const builder = useMemo(() => buildRow ?? buildModelMetricsRow, [buildRow]);
  const projectPath = useAppStore((s) => s.projectPath);
  const [dirs, setDirs] = useState<string[]>(runDirs);
  const [rows, setRows] = useState<ModelMetricsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ModelMetricsRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Reset the working dir set whenever the seed changes.
  useEffect(() => {
    setDirs(runDirs);
  }, [runDirs]);

  // Auto-detect trained models in the project's `models/` folder on open —
  // mirrors legacy SLEAP's MetricsTableDialog, which reuses the same
  // TrainingConfigsGetter scan as the training-config picker instead of
  // requiring every model to be added by hand. Merges into the existing dir
  // set (deduped by path); models without metrics yet still show up with —
  // dashes, same as a manually-added one.
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    (async () => {
      const { dirname } = await import("@tauri-apps/api/path");
      const projectDir = await dirname(projectPath);
      const models = await findTrainedModels(projectDir);
      if (cancelled || models.length === 0) return;
      setDirs((prev) => Array.from(new Set([...prev, ...models.map((m) => m.path)])));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  // (Re)load rows whenever the dialog is open and the dir set changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const built = await Promise.all(dirs.map((d) => builder(d)));
      if (!cancelled) {
        setRows(built);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, dirs, builder]);

  const handleAddModels = async () => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const picked = await tauriOpen({
        directory: true,
        multiple: true,
        title: "Add Trained Model(s)",
      });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      setDirs((prev) => Array.from(new Set([...prev, ...list])));
    } catch {
      /* cancelled, or not running under Tauri */
    }
  };

  const openDetail = (row: ModelMetricsRow) => {
    setSelected(row);
    setDetailOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Metrics for Trained Models</DialogTitle>
            <DialogDescription>
              Evaluation metrics for trained models. Click a row for detailed metrics.
            </DialogDescription>
          </DialogHeader>

          {/* Both-axis scroll so the wide 10-column table stays inside the
              dialog instead of spilling past its right edge. */}
          <div className="max-h-[60vh] w-full overflow-auto rounded-md border border-border/40">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((c) => (
                    <TableHead key={c} className="text-[11px]">
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="text-center text-muted-foreground text-xs py-6">
                      No trained models. Use “Add Trained Model(s)…” to add a run directory.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => {
                  const s = row.summary;
                  return (
                    <TableRow
                      key={row.path}
                      className="cursor-pointer text-[11px]"
                      onClick={() => openDetail(row)}
                    >
                      <TableCell className="font-mono max-w-[220px] truncate" title={row.path}>
                        {row.error && (
                          <AlertCircle className="inline h-3 w-3 mr-1 text-yellow-500 align-[-2px]" />
                        )}
                        {runDirName(row.path)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{row.timestamp ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.modelType ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.architecture ?? "—"}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.oksMAP)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.visPrecision)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.visRecall)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.distP95)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.distP75)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{fmt(s?.distAvg)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <DialogFooter className="sm:justify-between" showCloseButton>
            <Button variant="outline" size="sm" onClick={handleAddModels}>
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <FolderPlus className="h-3.5 w-3.5 mr-1" />
              )}
              Add Trained Model(s)…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DetailedModelMetricsDialog open={detailOpen} onOpenChange={setDetailOpen} row={selected} />
    </>
  );
}
