/**
 * Phase-3 "Correct predictions" panel.
 *
 * Rendered as the rightmost tab of the Active-Learning panel, but decoupled from
 * the loop: it works on ANY loaded project that contains scored predicted
 * instances — no workflow config required — so a predictions `.slp` can be
 * opened and corrected directly. When idle it sets up the review queue (worst
 * single keypoint first, capped at N); while active it doubles as the
 * per-keypoint confidence readout for the instance under review.
 */

import { useMemo, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { buildReviewQueue, resolveReviewInstance } from "@/lib/activeLearning/reviewQueue";
import { acceptAndAdvanceCorrection } from "@/lib/activeLearning/correctionActions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export function CorrectionPanel() {
  const labels = useAppStore((s) => s.labels);
  const skeleton = useAppStore((s) => s.skeleton);
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const active = useAppStore((s) => s.labelingMode === "correct");
  const queue = useAppStore((s) => s.correctQueue);
  const cursor = useAppStore((s) => s.correctCursor);
  const zoomWindow = useAppStore((s) => s.correctZoomWindow);
  const activeThreshold = useAppStore((s) => s.correctScoreThreshold);

  const [limit, setLimit] = useState(50);
  const [threshold, setThreshold] = useState(0.3);

  // How many predicted instances have a keypoint at/below the threshold. Only
  // computed when IDLE (it's the setup readout) — recomputing while correcting
  // would re-walk every frame on each overlayVersion bump (i.e. every drag frame).
  const availableCount = useMemo(
    () => (!active && labels ? buildReviewQueue(labels, { scoreThreshold: threshold }).length : 0),
    // overlayVersion stands in for "annotations changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, labels, overlayVersion, threshold],
  );

  const start = () => {
    const ls = useAppStore.getState().labels;
    if (!ls) return;
    const q = buildReviewQueue(ls, { limit, scoreThreshold: threshold });
    useAppStore.getState().enterCorrectMode({ queue: q, scoreThreshold: threshold });
  };

  if (!active) {
    return (
      <div className="space-y-3 p-2 text-xs">
        <div className="font-medium">Correct predictions</div>
        <p className="text-muted-foreground">
          Review the least-confident predictions instance by instance and fix the
          bad keypoints. Works on any project with scored predictions.
        </p>

        {!labels ? (
          <p className="text-muted-foreground">Open a project to begin.</p>
        ) : (
          <>
            <p>
              <span className="font-medium">{availableCount}</span> predicted
              instance{availableCount === 1 ? "" : "s"} with a keypoint ≤{" "}
              {threshold.toFixed(2)}.
            </p>

            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Review up to</span>
              <Input
                type="number"
                min={1}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                className="h-7 w-24"
              />
            </label>

            <label className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Flag keypoints ≤</span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(e) =>
                  setThreshold(Math.min(1, Math.max(0, Number(e.target.value) || 0)))
                }
                className="h-7 w-24"
              />
            </label>

            <Button
              size="sm"
              className="h-7 w-full"
              disabled={availableCount === 0}
              onClick={start}
            >
              Start correcting
            </Button>
            {availableCount === 0 && (
              <p className="text-muted-foreground">
                No predictions below the threshold — raise it to review more.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  const total = queue.length;
  const stop = () => useAppStore.getState().exitCorrectMode();

  if (cursor >= total) {
    return (
      <div className="space-y-3 p-2 text-xs">
        <div className="font-medium">Correct predictions</div>
        <p className="text-emerald-600 dark:text-emerald-500">
          {total === 0 ? "Nothing to review." : `All ${total} reviewed.`}
        </p>
        <Button size="sm" className="h-7 w-full" onClick={stop}>
          Done
        </Button>
      </div>
    );
  }

  const item = queue[cursor];
  // Resolve node names against the item instance's OWN skeleton (a project may
  // hold predictions on more than one skeleton), falling back to the active one.
  const itemSkeleton = labels ? resolveReviewInstance(labels, item)?.skeleton ?? skeleton : skeleton;
  // Per-keypoint confidence, worst first (unscored nodes sink to the bottom).
  const rows = item.pointScores
    .map((score, nodeIdx) => ({
      name: itemSkeleton?.nodes[nodeIdx]?.name ?? `node ${nodeIdx}`,
      score,
    }))
    .sort((a, b) => {
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return a.score - b.score;
    });

  return (
    <div className="space-y-3 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Correcting</span>
        <span className="text-muted-foreground">
          {cursor + 1} / {total}
        </span>
      </div>

      <div>
        <div className="mb-1 text-muted-foreground">Keypoint confidence (worst first)</div>
        <ul className="space-y-1">
          {rows.map((row, i) => {
            // Flag against the store threshold the queue/rings actually use, not
            // the local setup value (which resets if the panel remounts).
            const flagged = row.score !== null && row.score <= activeThreshold;
            return (
              <li key={i} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-[5.5rem] shrink-0 truncate",
                    flagged && "font-medium text-red-500",
                  )}
                  title={row.name}
                >
                  {row.name}
                </span>

                {/* Confidence meter. The tick marks the flag threshold, so a bar
                    falling short of it reads as "needs a look" at a glance. The
                    number stays visible — the bar is redundant encoding, never
                    the only signal (unscored points have no bar at all). */}
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  {row.score !== null && (
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full",
                        flagged ? "bg-red-500" : "bg-foreground/40",
                      )}
                      style={{ width: `${Math.max(0, Math.min(1, row.score)) * 100}%` }}
                    />
                  )}
                  {activeThreshold > 0 && activeThreshold < 1 && (
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/30"
                      style={{ left: `${activeThreshold * 100}%` }}
                    />
                  )}
                </div>

                <span
                  className={cn(
                    "w-8 shrink-0 text-right font-mono",
                    flagged ? "text-red-500" : "text-muted-foreground",
                  )}
                >
                  {row.score === null ? "—" : row.score.toFixed(2)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-muted-foreground">Zoom window</span>
          <span className="font-mono text-muted-foreground">{Math.round(zoomWindow)}px</span>
        </div>
        <Slider
          min={32}
          max={1024}
          step={8}
          value={[zoomWindow]}
          onValueChange={([v]) => useAppStore.getState().setCorrectZoomWindow(v)}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="h-7 flex-1" onClick={() => acceptAndAdvanceCorrection()}>
          Accept (Space)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().correctAdvance()}
        >
          Skip
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().correctBack()}
        >
          Back
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={stop}>
          Stop
        </Button>
      </div>
    </div>
  );
}
