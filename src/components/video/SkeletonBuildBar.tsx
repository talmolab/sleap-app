/**
 * On-canvas control bar for the visual skeleton builder.
 *
 * Rendered inside the VideoPlayer canvas container; shown only while
 * `skeletonBuildMode` is active. Drives the two build stages:
 *   1 · Place nodes   — click the frame to drop nodes (VideoPlayer handles the
 *                        pointer input); this bar offers Undo + advance.
 *   2 · Connect edges — drag pen-strokes to chain edges; this bar offers Back,
 *                        Undo, Clear edges, and Done.
 *
 * "Done" (and Escape) finalize the build: read the final node/edge counts from
 * the store, exit build mode, and toast a summary. All mutations elsewhere go
 * through the command system, so Undo here just calls `commandContext.undo()`.
 */

import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";
import { ClearEdgesCommand } from "@/commands/skeletonCommands";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";

// Shared styling for the bar's overlay buttons (dark, on the video canvas).
const barBtn =
  "pointer-events-auto bg-white/10 text-white/85 border-none hover:bg-white/20 hover:text-white";

export function SkeletonBuildBar() {
  const buildMode = useAppStore((s) => s.skeletonBuildMode);
  const stage = useAppStore((s) => s.skeletonBuildStage);

  // Finalize: read the LATEST store (not render-time selectors) so the summary
  // reflects any edits made after this component last rendered, then exit.
  const done = () => {
    const s = useAppStore.getState();
    const n = s.skeleton?.nodes.length ?? 0;
    const e = s.skeleton?.edges.length ?? 0;
    s.exitSkeletonBuild();
    toast.success(`Skeleton defined — ${n} node(s), ${e} edge(s)`);
  };

  // Escape = Done, while the bar is mounted in build mode.
  useEffect(() => {
    if (!buildMode) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        done();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `done` reads the store fresh on each call, so it need not be a dep.
  }, [buildMode]);

  if (!buildMode) return null;

  const setStage = (s: "place" | "connect") =>
    useAppStore.getState().setSkeletonBuildStage(s);

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1.5 shadow-lg backdrop-blur-sm pointer-events-auto">
      {stage === "place" ? (
        <>
          <span className="px-1 text-xs font-medium text-white/90">
            1 · Place nodes
          </span>
          <Button
            variant="secondary"
            size="xs"
            className={barBtn}
            onClick={() => commandContext.undo()}
          >
            Undo
          </Button>
          <Button
            variant="default"
            size="xs"
            className="pointer-events-auto"
            onClick={() => setStage("connect")}
          >
            Next: Connect edges →
          </Button>
        </>
      ) : (
        <>
          <span className="px-1 text-xs font-medium text-white/90">
            2 · Connect edges
          </span>
          <Button
            variant="secondary"
            size="xs"
            className={barBtn}
            onClick={() => setStage("place")}
          >
            ← Back
          </Button>
          <Button
            variant="secondary"
            size="xs"
            className={barBtn}
            onClick={() => commandContext.undo()}
          >
            Undo
          </Button>
          <Button
            variant="secondary"
            size="xs"
            className={barBtn}
            onClick={() => commandContext.execute(ClearEdgesCommand)}
          >
            Clear edges
          </Button>
          <Button
            variant="default"
            size="xs"
            className="pointer-events-auto"
            onClick={done}
          >
            Done
          </Button>
        </>
      )}
    </div>
  );
}
