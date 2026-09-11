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
 * Pure logic lives in labelQcRules.ts / labelQc.ts and lib/analyze/qc/*; this is
 * the thin view. The rule-based path is unchanged; the anomaly engine is scored
 * lazily, only when its tab is open.
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
import { useAppStore } from "@/stores/appStore";
import { runLabelQc, type QcFinding, type QcIssueKind } from "@/lib/analyze/labelQc";
import { scoreLabelsAnomaly, type AnomalyInstance } from "@/lib/analyze/qc/anomaly";
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

export function LabelQcDialog({ open, onOpenChange }: LabelQcDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const [tab, setTab] = useState<"rules" | "anomalies">("rules");

  const findings = useMemo<QcFinding[]>(
    () => (open && labels ? runLabelQc(labels) : []),
    [open, labels],
  );

  // Scored lazily: only when the Anomalies tab is open (it's heavier than the
  // rule checks — NN + per-instance feature extraction).
  const anomaly = useMemo(() => {
    if (!open || !labels || tab !== "anomalies") return null;
    try {
      return scoreLabelsAnomaly(labels);
    } catch {
      return { instances: [], featureNames: [] };
    }
  }, [open, labels, tab]);

  const flagged = useMemo(
    () =>
      (anomaly?.instances ?? [])
        .filter((i) => i.score >= ANOMALY_THRESHOLD)
        .sort((a, b) => b.score - a.score),
    [anomaly],
  );

  const multiVideo = (labels?.videos.length ?? 0) > 1;

  const navigate = (f: QcFinding) => {
    setVideo(f.video);
    setFrameIdx(f.frameIdx);
    if (f.instanceIdx !== undefined && labels) {
      const lf = labels.find({ video: f.video }).find((x) => x.frameIdx === f.frameIdx);
      setInstance(lf?.instances[f.instanceIdx] ?? null);
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
    setInstance(lf?.instances[a.instIdx] ?? null);
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
    toast.success(`Added ${incoming.length} flagged frame(s) to Suggestions`);
  };

  const exportCsv = () => {
    const scored = anomaly?.instances ?? [];
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Label Quality Check</DialogTitle>
          <DialogDescription>
            Rule-based checks and a statistical anomaly score for each instance.
            Click a row to jump to the frame.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "rules" | "anomalies")}>
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
          </TabsList>

          {/* ── Rule-based findings ── */}
          <TabsContent value="rules">
            {findings.length === 0 ? (
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
            {flagged.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {anomaly && anomaly.instances.length > 0
                  ? `No instances above the anomaly threshold (${anomaly.instances.length} scored). Export CSV for all scores.`
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
          </TabsContent>
        </Tabs>

        {tab === "rules" ? (
          <DialogFooter className="sm:justify-between" showCloseButton>
            <span className="text-xs text-muted-foreground">
              {findings.length} issue{findings.length === 1 ? "" : "s"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={findings.length === 0}
              onClick={addAllToSuggestions}
            >
              Add flagged frames to Suggestions
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter className="sm:justify-between" showCloseButton>
            <span className="text-xs text-muted-foreground">
              {flagged.length} flagged · {anomaly?.instances.length ?? 0} scored
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(anomaly?.instances.length ?? 0) === 0}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
