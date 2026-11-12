/**
 * Label Quality Check (Analyze menu).
 *
 * Two views over the loaded project:
 *  - "Rules": the rule-based QC (labelQc.ts) — common labeling issues as a flat
 *    list; click a row to jump to the flagged frame/instance, or append the
 *    flagged frames to Suggestions.
 *  - "Anomalies": the statistical QC engine (qc/anomaly.ts) — a per-instance
 *    anomaly score + confidence + dominant issue, worst-first, with CSV export.
 *
 * One explicitly triggered run ("Run QC") computes both, off the render path,
 * so opening the dialog is instant even on large projects; the anomaly part is
 * chunked-async (progress + cancel). Results live in qcStore, shared with the
 * Label QC side panel, and survive closing the dialog (clicking a row closes it
 * to show the frame). Pure logic lives in labelQc.ts and lib/analyze/qc/*.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { useAppStore } from "@/stores/appStore";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { QC_KIND_LABEL, type QcFinding } from "@/lib/analyze/labelQc";
import {
  anomalyVerdict,
  type AnomalyInstance,
  type AnomalyVerdict,
} from "@/lib/analyze/qc/anomaly";
import { makeQCConfig } from "@/lib/analyze/qc/config";
import { useQcStore } from "@/stores/qcStore";
import { qcResultsCsv } from "@/lib/analyze/qc/csv";
import { saveQcCsv } from "@/lib/analyze/qc/saveQcCsv";
import { mergeSuggestions } from "@/lib/suggestionEdits";
import type { SuggestionFrame } from "@/types";

export interface LabelQcDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CONF_CLASS: Record<AnomalyInstance["confidence"], string> = {
  high: "text-red-500",
  medium: "text-amber-500",
  low: "text-muted-foreground",
};

export function LabelQcDialog({ open, onOpenChange }: LabelQcDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const [tab, setTab] = useState<"rules" | "anomalies">("rules");

  const {
    labels: qcLabels,
    state: runState,
    progress: anomProgress,
    findings,
    anomaly: anomResult,
    threshold: anomThreshold,
    run,
    cancel: cancelAnomalies,
    setThreshold: setAnomThreshold,
  } = useQcStore();
  // Results for another project are cleared by qcStore; this guards the render
  // in between.
  const anomState = qcLabels === labels ? runState : "idle";

  // Flagged by either statistical check (anomaly ≥ the slider, or GMM ≥ its
  // fixed least-typical-5% threshold), worst first.
  const flagged = useMemo(
    () =>
      (anomResult?.instances ?? [])
        .map((a): [AnomalyInstance, AnomalyVerdict] => [
          a,
          anomalyVerdict(a, anomThreshold, anomResult?.gmmThreshold ?? null),
        ])
        .filter(([, v]) => v.flagged)
        .sort(([, x], [, y]) => y.score - x.score),
    [anomResult, anomThreshold],
  );

  const multiVideo = (labels?.videos.length ?? 0) > 1;

  const runQc = () => {
    if (labels) void run(labels);
  };

  const navigate = (f: QcFinding) => {
    setVideo(f.video);
    setFrameIdx(f.frameIdx);
    if (f.instanceIdx !== undefined && labels) {
      const lf = labels.find({ video: f.video }).find((x) => x.frameIdx === f.frameIdx);
      // Indices are relative to userInstances (QC scores labels, not predictions).
      setInstance(lf?.userInstances[f.instanceIdx] ?? null);
    } else {
      setInstance(null);
    }
    onOpenChange(false);
  };

  const navigateAnomaly = (a: AnomalyInstance) => {
    if (!labels) return;
    const video = labels.videos[a.videoIdx];
    if (!video) return;
    setVideo(video);
    setFrameIdx(a.frameIdx);
    const lf = labels.find({ video }).find((x) => x.frameIdx === a.frameIdx);
    // instIdx is relative to userInstances (QC scores labels, not predictions).
    setInstance(lf?.userInstances[a.instIdx] ?? null);
    onOpenChange(false);
  };

  const addAllToSuggestions = () => {
    if (!labels || findings.length === 0) return;
    const seen = new Set<string>();
    const incoming: SuggestionFrame[] = [];
    for (const f of findings) {
      const key = `${f.videoIdx}:${f.frameIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incoming.push({ video: f.video, frameIdx: f.frameIdx } as SuggestionFrame);
    }
    labels.suggestions = mergeSuggestions(labels.suggestions, incoming);
    useAppStore.getState().markChanged();
    // Changed project-level suggestions (not a frame's instances) → structural.
    dirtyFrameTracker.markStructural();
    toast.success(`Added ${incoming.length} flagged frame(s) to Suggestions`);
  };

  const exportCsv = () => {
    const scored = anomResult?.instances ?? [];
    if (scored.length === 0) return;
    const csv = qcResultsCsv(
      scored.map((i) => ({
        videoIdx: i.videoIdx,
        frameIdx: i.frameIdx,
        instIdx: i.instIdx,
        score: i.score,
        gmmScore: i.gmmScore,
        contributions: i.contributions,
      })),
    );
    void saveQcCsv(csv);
  };

  const frameCell = (videoIdx: number, frameIdx: number, instIdx?: number) =>
    `${multiVideo ? `V${videoIdx + 1} · ` : ""}${frameIdx}${
      instIdx !== undefined ? ` · inst ${instIdx + 1}` : ""
    }`;

  /** Centered "Run" prompt shown before an analysis has been run. */
  const runPrompt = (label: string, onRun: () => void) => (
    <div className="flex flex-col items-center gap-3 py-10">
      <p className="text-sm text-muted-foreground">
        Analysis hasn&apos;t been run yet.
      </p>
      <Button size="sm" onClick={onRun} disabled={!labels}>
        {label}
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Label Quality Check</DialogTitle>
          <DialogDescription>
            Rule-based checks and a statistical anomaly score for each instance.
            Run a check, then click a row to jump to the frame.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "rules" | "anomalies")}>
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
          </TabsList>

          {/* ── Rule-based findings ── */}
          <TabsContent value="rules">
            {anomState === "idle" ? (
              runPrompt("Run QC", runQc)
            ) : anomState === "running" ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Running checks…
              </p>
            ) : findings.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No issues found in the current labels.
              </p>
            ) : (
              <div className="max-h-[50vh] overflow-auto rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px]">Issue</TableHead>
                      <TableHead className="text-[11px]">Frame</TableHead>
                      <TableHead className="text-[11px]">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {findings.map((f, i) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer text-[11px]"
                        onClick={() => navigate(f)}
                      >
                        <TableCell className="whitespace-nowrap font-medium">
                          {QC_KIND_LABEL[f.kind]}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono tabular-nums">
                          {frameCell(f.videoIdx, f.frameIdx, f.instanceIdx)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{f.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* ── Statistical anomaly scores ── */}
          <TabsContent value="anomalies">
            {anomState === "idle" ? (
              runPrompt("Run QC", runQc)
            ) : anomState === "running" ? (
              <div className="flex flex-col items-center gap-3 py-10">
                <p className="text-sm text-muted-foreground">
                  Analyzing… {Math.round(anomProgress * 100)}%
                </p>
                <div className="h-1.5 w-64 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-primary transition-[width]"
                    style={{ width: `${Math.round(anomProgress * 100)}%` }}
                  />
                </div>
                <Button size="sm" variant="outline" onClick={cancelAnomalies}>
                  Cancel
                </Button>
              </div>
            ) : (
              // done — a live threshold slider (when there are scored instances)
              // over the flagged list; lowering it flags more (PyQt's knob).
              <div className="flex flex-col gap-3">
                {(anomResult?.instances.length ?? 0) > 0 && (
                  <div className="flex items-center gap-3 px-1 pt-1">
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                      Threshold
                    </span>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={[anomThreshold]}
                      onValueChange={([v]) => setAnomThreshold(v)}
                      className="flex-1"
                      aria-label="Anomaly flag threshold"
                    />
                    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
                      ≥ {anomThreshold.toFixed(2)} · {flagged.length}/
                      {anomResult?.instances.length ?? 0}
                    </span>
                  </div>
                )}
                {(anomResult?.instances.length ?? 0) > 0 && (
                  <p className="px-1 text-[11px] text-muted-foreground">
                    {anomResult?.gmmThreshold != null
                      ? `GMM: also flags the least typical ${Math.round((1 - anomResult.gmmThreshold) * 100)}% of poses (score ≥ ${anomResult.gmmThreshold.toFixed(2)}), whatever the threshold above.`
                      : `GMM: needs at least ${makeQCConfig().gmmMinSamples} labeled instances, so only the anomaly score is used.`}
                  </p>
                )}
                {flagged.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {(anomResult?.instances.length ?? 0) > 0
                      ? "No instances at or above this threshold — lower it to flag more. Export CSV for all scores."
                      : "No instances to score."}
                  </p>
                ) : (
                  <div className="max-h-[50vh] overflow-auto rounded-md border border-border/40">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-[11px]">Score</TableHead>
                          <TableHead className="text-[11px]">GMM</TableHead>
                          <TableHead className="text-[11px]">Confidence</TableHead>
                          <TableHead className="text-[11px]">Top issue</TableHead>
                          <TableHead className="text-[11px]">Frame</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {flagged.map(([a, v]) => (
                          <TableRow
                            key={`${a.videoIdx}:${a.frameIdx}:${a.instIdx}`}
                            className="cursor-pointer text-[11px]"
                            onClick={() => navigateAnomaly(a)}
                          >
                            <TableCell
                              className={`whitespace-nowrap font-mono tabular-nums ${v.by === "gmm" ? "text-muted-foreground" : "font-medium"}`}
                            >
                              {a.score.toFixed(2)}
                            </TableCell>
                            <TableCell
                              className={`whitespace-nowrap font-mono tabular-nums ${v.by === "anomaly" ? "text-muted-foreground" : "font-medium"}`}
                            >
                              {a.gmmScore != null ? a.gmmScore.toFixed(2) : "—"}
                            </TableCell>
                            <TableCell
                              className={`whitespace-nowrap font-medium ${CONF_CLASS[v.confidence]}`}
                            >
                              {v.confidence}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{v.issue}</TableCell>
                            <TableCell className="whitespace-nowrap font-mono tabular-nums">
                              {frameCell(a.videoIdx, a.frameIdx, a.instIdx)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {tab === "rules" ? (
          <DialogFooter className="sm:justify-between" showCloseButton>
            <span className="text-xs text-muted-foreground">
              {anomState === "done"
                ? `${findings.length} issue${findings.length === 1 ? "" : "s"}`
                : ""}
            </span>
            <div className="flex gap-2">
              {anomState === "done" && (
                <Button variant="ghost" size="sm" onClick={runQc}>
                  Re-run
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={anomState !== "done" || findings.length === 0}
                onClick={addAllToSuggestions}
              >
                Add flagged frames to Suggestions
              </Button>
            </div>
          </DialogFooter>
        ) : (
          <DialogFooter className="sm:justify-between" showCloseButton>
            <span className="text-xs text-muted-foreground">
              {anomState === "done"
                ? `${flagged.length} flagged · ${anomResult?.instances.length ?? 0} scored`
                : ""}
            </span>
            <div className="flex gap-2">
              {anomState === "done" && (
                <Button variant="ghost" size="sm" onClick={runQc}>
                  Re-run
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={anomState !== "done" || (anomResult?.instances.length ?? 0) === 0}
                onClick={exportCsv}
              >
                Export CSV
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
