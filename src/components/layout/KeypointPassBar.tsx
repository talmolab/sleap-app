/**
 * Persistent top bar shown during a Phase-2 keypoint pass (issue #212).
 *
 * Mirrors {@link SeedModeBar}: layout-flow chrome at the top of the video pane,
 * full window width. Its centerpiece is a breadcrumb of the current pass's
 * nodes in click order — already-labeled nodes greyed, the one about to be
 * placed bold, upcoming ones normal — ending in a "Next instance"/"Next pass"
 * marker so the labeler always knows what's next without hunting.
 */

import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { advance, linearIndex, totalSteps } from "@/lib/activeLearning/passEngine";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modKey } from "../../lib/platform";
import { HelpCircle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function KeypointPassBar() {
  const active = useAppStore((s) => s.labelingMode === "keypointPass");
  const passCursor = useAppStore((s) => s.passCursor);
  const passDims = useAppStore((s) => s.passDims);
  const passNodeIndices = useAppStore((s) => s.passNodeIndices);
  const skeleton = useAppStore((s) => s.skeleton);
  const config = useActiveLearningStore((s) => s.config);

  if (!active || !passDims) return null;

  const done = () => useAppStore.getState().exitKeypointPassMode();

  // Sweep complete: cursor is null while the mode is still active.
  if (!passCursor) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-emerald-600/10 px-3 py-1.5 text-xs">
        <span className="font-medium text-emerald-600 dark:text-emerald-500">
          Phase 2 complete
        </span>
        <span className="text-muted-foreground">
          all {totalSteps(passDims)} placements swept
        </span>
        <div className="ml-auto">
          <Button size="sm" className="h-7" onClick={done}>
            Done (Esc)
          </Button>
        </div>
      </div>
    );
  }

  const passName = config?.labelKeypoints.passes[passCursor.passIdx]?.name;
  const nodeIdxs = passNodeIndices[passCursor.passIdx] ?? [];
  const nodeNames = nodeIdxs.map((i) => skeleton?.nodes[i]?.name ?? `node ${i}`);

  // What comes after this instance's last node in the current pass isn't fixed
  // by the sweep order alone — at a pass boundary (pass-major) or item boundary
  // (crop-major) it flips, and the final node ends the sweep. Ask advance().
  const afterPass = advance(
    { passIdx: passCursor.passIdx, itemIdx: passCursor.itemIdx, nodeIdx: nodeIdxs.length - 1 },
    passDims,
  );
  let terminal: string;
  if (!afterPass) {
    terminal = "Finish";
  } else {
    const passChanged = afterPass.passIdx !== passCursor.passIdx;
    const itemChanged = afterPass.itemIdx !== passCursor.itemIdx;
    if (passChanged && itemChanged) {
      // Both rolled over → the OUTER loop of this order advanced.
      terminal = passDims.order === "crop-major" ? "Next instance" : "Next pass";
    } else if (passChanged) {
      terminal = "Next pass";
    } else {
      terminal = "Next instance";
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
      <span className="font-medium whitespace-nowrap">
        Pass {passCursor.passIdx + 1}/{passDims.passCount}
        {passName ? `· ${passName}` : ""}
      </span>

      {/* Node sequence breadcrumb: done (grey) › current (bold) › upcoming. */}
      <div className="flex items-center gap-1 overflow-x-auto min-w-0">
        {nodeNames.map((name, i) => (
          <span key={i} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
            <span
              className={cn(
                i < passCursor.nodeIdx && "text-muted-foreground/50 line-through",
                i === passCursor.nodeIdx && "font-semibold text-foreground",
                i > passCursor.nodeIdx && "text-muted-foreground",
              )}
            >
              {name}
            </span>
          </span>
        ))}
        <span className="flex items-center gap-1 whitespace-nowrap">
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          <span className="text-muted-foreground/70 italic">{terminal}</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
        <span className="text-muted-foreground">
          instance {passCursor.itemIdx + 1}/{passDims.itemCount} ·{" "}
          {linearIndex(passCursor, passDims) + 1}/{totalSteps(passDims)}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Keyboard shortcuts">
              <HelpCircle className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 text-xs">
            <div className="mb-2 font-medium">Keypoint-pass shortcuts</div>
            <div className="space-y-1.5">
              <KeyRow keys="Click" action="Place current node" />
              <KeyRow keys="Right-click" action="Mark not visible" />
              <KeyRow keys="S" action="Skip node" />
              <KeyRow keys="B / ⌫" action="Step back" />
              <KeyRow keys="⌥ / Space drag" action="Pan" />
              <KeyRow keys={`${modKey}+Z`} action="Undo" />
              <KeyRow keys="Esc" action="Done" />
            </div>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().passStepBack()}
        >
          ← Back (B)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => useAppStore.getState().passAdvance()}
        >
          Skip (S)
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={done}>
          Done (Esc)
        </Button>
      </div>
    </div>
  );
}
