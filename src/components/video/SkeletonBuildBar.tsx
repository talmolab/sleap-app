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
 * "Done" captures the drawn layout as this session's template (so a later Add
 * Instance lands in the drawn orientation), then prompts whether to also drop an
 * instance on the current frame right now. "Escape" quietly exits the build MODE
 * only — no capture, no prompt, no toast (nodes/edges applied live remain). All
 * mutations elsewhere go through the command system, so Undo here just calls
 * `commandContext.undo()`.
 */

import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";
import { ClearEdgesCommand } from "@/commands/skeletonCommands";
import { AddInstance } from "@/commands/editCommands";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Shared styling for the bar's overlay buttons (dark, on the video canvas).
const barBtn =
  "pointer-events-auto bg-white/10 text-white/85 border-none hover:bg-white/20 hover:text-white";

export function SkeletonBuildBar() {
  const buildMode = useAppStore((s) => s.skeletonBuildMode);
  const stage = useAppStore((s) => s.skeletonBuildStage);
  const [confirmInstanceOpen, setConfirmInstanceOpen] = useState(false);

  // Finalize the build: read the LATEST store (not render-time selectors) so the
  // summary reflects any edits made after this component last rendered, exit
  // build mode, and toast. `suffix` marks the create-instance variant.
  const finalize = (suffix = "") => {
    const s = useAppStore.getState();
    const n = s.skeleton?.nodes.length ?? 0;
    const e = s.skeleton?.edges.length ?? 0;
    s.exitSkeletonBuild();
    toast.success(`Skeleton defined — ${n} node(s), ${e} edge(s)${suffix}`);
  };

  // "Done": snapshot the drawn layout as the session template FIRST (capture
  // happens regardless of the instance choice, so future Add Instance seeds from
  // the drawn orientation), then ask whether to also create an instance now.
  const done = () => {
    useAppStore.getState().captureSkeletonTemplateLayout();
    setConfirmInstanceOpen(true);
  };

  // "Not now": keep the captured template, just finalize without an instance.
  const finishWithoutInstance = () => {
    setConfirmInstanceOpen(false);
    finalize();
  };

  // "Create instance": add an instance on the current frame from the captured
  // layout, then finalize. AddInstance's synchronous body runs before its
  // promise settles, so the frame is mutated immediately.
  const finishWithInstance = () => {
    void commandContext.execute(AddInstance);
    setConfirmInstanceOpen(false);
    finalize(" · instance added");
  };

  // Escape = quiet exit of the MODE only: no capture, no prompt, no toast.
  // (Nodes/edges already applied live remain — Escape cancels the mode.) When
  // the confirm dialog is open, let ITS own Escape close it (don't double-handle).
  useEffect(() => {
    if (!buildMode) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (confirmInstanceOpen) return;
      ev.preventDefault();
      ev.stopPropagation();
      useAppStore.getState().exitSkeletonBuild();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buildMode, confirmInstanceOpen]);

  if (!buildMode) return null;

  const setStage = (s: "place" | "connect") =>
    useAppStore.getState().setSkeletonBuildStage(s);

  return (
    <>
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1">
        <div className="flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1.5 shadow-lg backdrop-blur-sm pointer-events-auto">
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
        {stage === "place" && (
          <span className="rounded bg-black/60 px-2 py-0.5 text-[11px] text-white/70 backdrop-blur-sm">
            Double-click a node to rename it
          </span>
        )}
      </div>

      {/* Create-instance confirmation (shown after Done captures the layout). */}
      <Dialog open={confirmInstanceOpen} onOpenChange={setConfirmInstanceOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Skeleton defined</DialogTitle>
            <DialogDescription>
              Create a new instance on this frame from your layout?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={finishWithoutInstance}
            >
              Not now
            </Button>
            <Button size="sm" onClick={finishWithInstance}>
              Create instance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
