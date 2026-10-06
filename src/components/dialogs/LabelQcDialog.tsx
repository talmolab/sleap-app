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
 * Both analyses are **explicitly triggered** ("Run") and computed off the render
 * path so opening the dialog is instant even on large projects. The anomaly run
 * is chunked-async (progress + cancel) so it never freezes the UI; the rule run
 * yields once to paint a spinner, then runs (it's the lighter check). Pure logic
 * lives in labelQcRules.ts / labelQc.ts and lib/analyze/qc/*; this is the view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
import { runLabelQc, type QcFinding, type QcIssueKind } from "@/lib/analyze/labelQc";
import {
  scoreLabelsAnomalyAsync,
  type AnomalyInstance,
  type AnomalyResult,
} from "@/lib/analyze/qc/anomaly";
import { yieldToEvent } from "@/lib/analyze/qc/detector";
import { makeQCConfig } from "@/lib/analyze/qc/config";
import { qcResultsCsv } from "@/lib/analyze/qc/csv";
import { saveQcCsv } from "@/lib/analyze/qc/saveQcCsv";
import { mergeSuggestions } from "@/lib/suggestionEdits";
import type { SuggestionFrame } from "@/types";

export interface LabelQcDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KIND_LABEL: Record<QcIssueKind, string> = {
  duplicate: "Duplicate",
  incomplete_frame: "Incomplete frame",
  negative_frame: "Negative frame",
  sparse_instance: "Sparse instance",
  empty_instance: "Empty instance",
  out_of_range: "Out of range",
  chain_order: "Chain order",
  chirality: "Chirality (L/R)",
};

/** Anomaly flag threshold on the [0,1] score (sigmoid(maxZ - 3) >= 0.7). */
const ANOMALY_THRESHOLD = makeQCConfig().instanceThreshold;

const CONF_CLASS: Record<AnomalyInstance["confidence"], string> = {
  high: "text-red-500",
  medium: "text-amber-500",
  low: "text-muted-foreground",
};

type RunState = "idle" | "running" | "done";

export function LabelQcDialog({ open, onOpenChange }: LabelQcDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const [tab, setTab] = useState<"rules" | "anomalies">("rules");

  // Rule-based checks (explicit run; lighter, single yield to paint the spinner).
  const [rulesState, setRulesState] = useState<RunState>("idle");
  const [findings, setFindings] = useState<QcFinding[]>([]);

  // Anomaly analysis (explicit run; chunked-async with progress + cancel).
  const [anomState, setAnomState] = useState<RunState>("idle");
  const [anomProgress, setAnomProgress] = useState(0);
  const [anomResult, setAnomResult] = useState<AnomalyResult | null>(null);
  // Live flag threshold on the [0,1] anomaly score (PyQt exposes the same knob).
  // Lower it to flag more (more sensitive), raise it to flag only the worst.
  const [anomThreshold, setAnomThreshold] = useState(ANOMALY_THRESHOLD);
  const anomAbort = useRef<AbortController | null>(null);

  // Reset when the dialog closes or the project changes (stale results must not
  // linger); abort any in-flight anomaly run on close/unmount.
  useEffect(() => {
    setRulesState("idle");
    setFindings([]);
    setAnomState("idle");
    setAnomProgress(0);
    setAnomResult(null);
    anomAbort.current?.abort();
    anomAbort.current = null;
    return () => {
      anomAbort.current?.abort();
      anomAbort.current = null;
    };
  }, [open, labels]);

  const flagged = useMemo(
    () =>
      (anomResult?.instances ?? [])
        .filter((i) => i.score >= anomThreshold)
        .sort((a, b) => b.score - a.score),
    [anomResult, anomThreshold],
  );

  const multiVideo = (labels?.videos.length ?? 0) > 1;

  const runRules = async () => {
    if (!labels) return;
    setRulesState("running");
    await yieldToEvent(); // let the spinner paint before the sync sweep
    try {
      setFindings(runLabelQc(labels));
    } catch {
      setFindings([]);
    }
    setRulesState("done");
  };

  const runAnomalies = async () => {
    if (!labels) return;
    const ac = new AbortController();
    anomAbort.current = ac;
    setAnomState("running");
    setAnomProgress(0);
    try {
      const r = await scoreLabelsAnomalyAsync(labels, {
        onProgress: setAnomProgress,
        signal: ac.signal,
      });
      setAnomResult(r);
      setAnomState("done");
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setAnomState("idle"); // cancelled → back to the Run button
      } else {
        setAnomResult({ instances: [], featureNames: [] });
        setAnomState("done");
      }
    } finally {
      anomAbort.current = null;
    }
  };

  const cancelAnomalies = () => anomAbort.current?.abort();

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
            {rulesState === "idle" ? (
              runPrompt("Run checks", runRules)
            ) : rulesState === "running" ? (
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
                          {KIND_LABEL[f.kind]}
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
              runPrompt("Run analysis", runAnomalies)
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
                          <TableHead className="text-[11px]">Confidence</TableHead>
                          <TableHead className="text-[11px]">Top issue</TableHead>
                          <TableHead className="text-[11px]">Frame</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {flagged.map((a) => (
                          <TableRow
                            key={`${a.videoIdx}:${a.frameIdx}:${a.instIdx}`}
                            className="cursor-pointer text-[11px]"
                            onClick={() => navigateAnomaly(a)}
                          >
                            <TableCell className="whitespace-nowrap font-mono tabular-nums font-medium">
                              {a.score.toFixed(2)}
                            </TableCell>
                            <TableCell
                              className={`whitespace-nowrap font-medium ${CONF_CLASS[a.confidence]}`}
                            >
                              {a.confidence}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{a.topIssue}</TableCell>
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
              {rulesState === "done"
                ? `${findings.length} issue${findings.length === 1 ? "" : "s"}`
                : ""}
            </span>
            <div className="flex gap-2">
              {rulesState === "done" && (
                <Button variant="ghost" size="sm" onClick={runRules}>
                  Re-run
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={rulesState !== "done" || findings.length === 0}
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
                <Button variant="ghost" size="sm" onClick={runAnomalies}>
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
