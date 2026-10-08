/**
 * Persistent top bar shown while centroid-seeding is active (issue #212).
 *
 * Rendered in the layout flow at the top of the video pane (not a floating
 * overlay), so it reads as toolbar chrome rather than a transient popup. Holds
 * the visible frame-advance controls plus a "?" cheatsheet of the essential
 * keys, so the interaction isn't a guessing game.
 */

import { useAppStore } from "../../stores/appStore";
import { commandContext, GoNextSuggestion, GoPrevSuggestion } from "../../commands";
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

export function SeedModeBar() {
  const seeding = useAppStore((s) => s.labelingMode === "seed");
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);

  if (!seeding) return null;

  const suggestions = labels?.suggestions ?? [];
  const total = suggestions.length;

  // 1-based position within the global suggestion order (video, then frame).
  let position = 0;
  if (total > 0 && video && labels) {
    const vi = new Map(labels.videos.map((v, i) => [v, i] as const));
    const ordered = [...suggestions].sort((a, b) => {
      const va = vi.get(a.video) ?? 0;
      const vb = vi.get(b.video) ?? 0;
      return va !== vb ? va - vb : a.frameIdx - b.frameIdx;
    });
    position = ordered.findIndex((s) => s.video === video && s.frameIdx === frameIdx) + 1;
  }

  const advance = (dir: 1 | -1) => {
    if (total > 0) {
      commandContext.execute(dir === 1 ? GoNextSuggestion : GoPrevSuggestion);
    } else {
      useAppStore.getState().incrementFrameIdx(dir);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
      <span className="font-medium">Labeling centroids</span>
      <span className="text-muted-foreground">click a body-center on each animal</span>
      {total > 0 && (
        <span className="text-muted-foreground">· frame {position || "—"} / {total}</span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Keyboard shortcuts">
              <HelpCircle className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 text-xs">
            <div className="mb-2 font-medium">Seeding shortcuts</div>
            <div className="space-y-1.5">
              <KeyRow keys="Click" action="Drop centroid" />
              <KeyRow keys="Right-click" action="Remove centroid" />
              <KeyRow keys="Space" action="Next frame" />
              <KeyRow keys="⇧ Space" action="Previous frame" />
              <KeyRow keys="⌥ drag" action="Pan" />
              <KeyRow keys={`${modKey}+Z`} action="Undo" />
              <KeyRow keys="Esc" action="Done" />
            </div>
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="outline" className="h-7" onClick={() => advance(-1)}>
          ← Prev
        </Button>
        <Button size="sm" className="h-7" onClick={() => advance(1)}>
          Next frame (Space) →
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={() => useAppStore.getState().exitSeedMode()}
        >
          Done (Esc)
        </Button>
      </div>
    </div>
  );
}
