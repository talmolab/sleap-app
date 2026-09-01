/**
 * Label Quality Check (Analyze menu, Tier 2).
 *
 * Runs the rule-based QC (labelQc.ts) over the loaded project and lists the
 * findings in a table. Click a row to jump to the flagged frame/instance (and
 * close); "Add flagged frames to Suggestions" appends the unique flagged frames
 * to the suggestions list. Pure logic lives in labelQcRules.ts / labelQc.ts;
 * this is the thin view.
 */
import { useMemo } from "react";
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
import { useAppStore } from "@/stores/appStore";
import { runLabelQc, type QcFinding, type QcIssueKind } from "@/lib/analyze/labelQc";
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
};

export function LabelQcDialog({ open, onOpenChange }: LabelQcDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const setInstance = useAppStore((s) => s.setInstance);

  const findings = useMemo<QcFinding[]>(
    () => (open && labels ? runLabelQc(labels) : []),
    [open, labels],
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Label Quality Check</DialogTitle>
          <DialogDescription>
            Rule-based checks for common labeling issues. Click a row to jump to the frame.
          </DialogDescription>
        </DialogHeader>

        {findings.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No issues found in the current labels.
          </p>
        ) : (
          <div className="max-h-[55vh] overflow-auto rounded-md border border-border/40">
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
                    <TableCell className="whitespace-nowrap font-medium">{KIND_LABEL[f.kind]}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono tabular-nums">
                      {multiVideo ? `V${f.videoIdx + 1} · ${f.frameIdx}` : f.frameIdx}
                      {f.instanceIdx !== undefined ? ` · inst ${f.instanceIdx + 1}` : ""}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

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
      </DialogContent>
    </Dialog>
  );
}
