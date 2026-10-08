/**
 * Persistent top bar shown during Phase-3 keypoint correction.
 *
 * Mirrors {@link KeypointPassBar}: full-width chrome at the top of the video
 * pane. Shows which queued instance is under review (worst-first) and its worst
 * keypoint, with Accept / Skip / Back controls so the flow is discoverable
 * without knowing the keyboard shortcuts.
 */

import { useAppStore } from "../../stores/appStore";
import { resolveReviewInstance } from "@/lib/activeLearning/reviewQueue";
import { acceptAndAdvanceCorrection } from "@/lib/activeLearning/correctionActions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modKey } from "../../lib/platform";
import { HelpCircle } from "lucide-react";

/** One key → action row in the cheatsheet. */
function KeyRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
        {keys}
      </kbd>
      <span className="text-muted-foreground">{action}</span>
    </div>
  );
}

export function CorrectionBar() {
  const active = useAppStore((s) => s.labelingMode === "correct");
  const queue = useAppStore((s) => s.correctQueue);
  const cursor = useAppStore((s) => s.correctCursor);
  const skeleton = useAppStore((s) => s.skeleton);
  const labels = useAppStore((s) => s.labels);

  if (!active) return null;

  const done = () => useAppStore.getState().exitCorrectMode();
  const total = queue.length;

  // Past the end (or an empty queue) → the completed state.
  if (cursor >= total) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-emerald-600/10 px-3 py-1.5 text-xs">
        <span className="font-medium text-emerald-600 dark:text-emerald-500">
          Correction complete
        </span>
        <span className="text-muted-foreground">
          {total === 0 ? "nothing to review" : `${total} instance${total === 1 ? "" : "s"} reviewed`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {total > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => useAppStore.getState().correctBack()}
            >
              ← Back (B)
            </Button>
          )}
          <Button size="sm" className="h-7" onClick={done}>
            Done (Esc)
          </Button>
        </div>
      </div>
    );
  }

  const item = queue[cursor];
  // Name the worst keypoint from the item instance's OWN skeleton (multi-skeleton
  // projects), falling back to the active skeleton.
  const itemSkeleton = labels ? resolveReviewInstance(labels, item)?.skeleton ?? skeleton : skeleton;
  const worstName = itemSkeleton?.nodes[item.worstNodeIdx]?.name ?? `node ${item.worstNodeIdx}`;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
      <span className="font-medium whitespace-nowrap">
        Correcting {cursor + 1}/{total}
      </span>
      <span className="whitespace-nowrap text-muted-foreground">
        worst keypoint:{" "}
        <span className="font-medium text-foreground">{worstName}</span>{" "}
        <span className="font-mono text-red-500">{item.worstScore.toFixed(2)}</span>
      </span>
      {item.instanceScore !== null && (
        <span className="whitespace-nowrap text-muted-foreground">
          instance {item.instanceScore.toFixed(2)}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Keyboard shortcuts">
              <HelpCircle className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 text-xs">
            <div className="mb-2 font-medium">Correction shortcuts</div>
            <div className="space-y-1.5">
              <KeyRow keys="Drag" action="Move a keypoint (adopts + corrects)" />
              <KeyRow keys="Right-click" action="Mark keypoint not-visible" />
              <KeyRow keys="Space" action="Accept + next" />
              <KeyRow keys="S" action="Skip (leave predicted)" />
              <KeyRow keys="B / ⌫" action="Back" />
              <KeyRow keys={`${modKey}+Z`} action="Undo" />
              <KeyRow keys="Esc" action="Done" />
            </div>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().correctBack()}
        >
          ← Back (B)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().correctAdvance()}
        >
          Skip (S)
        </Button>
        <Button size="sm" className="h-7" onClick={() => acceptAndAdvanceCorrection()}>
          Accept (Space)
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={done}>
          Done (Esc)
        </Button>
      </div>
    </div>
  );
}
