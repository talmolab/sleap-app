/**
 * Labels › Bounding Boxes › Boxes from Poses (#488): add a padded box around
 * every pose instance that has no box yet, on this frame or every frame.
 * While open, the boxes it would add on the current frame are previewed on the
 * canvas, updating with the padding.
 *
 * It opens with the settings of View ▸ Show Boxes Around Poses (padding, and
 * whether predictions get boxes), so "Make Shown Boxes Real…" in the View panel
 * saves exactly the boxes on screen.
 */
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { BboxesFromPoses, posesToBboxes } from "@/commands/bboxCommands";
import { normalizeBboxPadding } from "@/lib/poseBboxes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function BboxesFromPosesDialog() {
  const open = useAppStore((s) => s.bboxFromPosesOpen);
  const labels = useAppStore((s) => s.labels);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  // Labels are edited in place: this is what changes when they do.
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const [padding, setPadding] = useState("0");
  const [includePredicted, setIncludePredicted] = useState(false);
  const [scope, setScope] = useState<"frame" | "project">("project");
  // sleap-nn requires bbox_padding >= 0.
  const pad = normalizeBboxPadding(padding);

  // Start from the View ▸ Show Boxes Around Poses settings each time it opens.
  useEffect(() => {
    if (!open) return;
    const s = useAppStore.getState();
    setPadding(String(s.poseBboxPadding));
    setIncludePredicted(s.poseBboxIncludePredicted);
  }, [open]);

  // Live preview on the canvas while open.
  useEffect(() => {
    const s = useAppStore.getState();
    s.set("bboxPosePreviewPadding", open ? pad : null);
    s.set("bboxPosePreviewIncludePredicted", open && includePredicted);
  }, [open, pad, includePredicted]);

  const counts = useMemo(() => {
    void overlayVersion;
    if (!open || !labels) return { frame: 0, project: 0, drawnBoxes: false };
    const frame = labeledFrame ? posesToBboxes(labeledFrame, pad, includePredicted).length : 0;
    let project = 0;
    let drawnBoxes = false;
    for (const lf of labels.labeledFrames) {
      project += posesToBboxes(lf, pad, includePredicted).length;
      if (!drawnBoxes) drawnBoxes = lf.bboxes.some((b) => !b.isPredicted);
    }
    return { frame, project, drawnBoxes };
  }, [open, labels, labeledFrame, pad, includePredicted, overlayVersion]);

  const close = () => useAppStore.getState().set("bboxFromPosesOpen", false);
  const apply = async () => {
    await commandContext.execute(BboxesFromPoses, { padding: pad, scope, includePredicted });
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Boxes from Poses</DialogTitle>
          <DialogDescription>
            Adds a box around each instance that doesn't have one, linked to it and on its track.
            With padding 0 (sleap-nn&apos;s default) these match the boxes sleap-nn makes from
            poses when a project has no drawn boxes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>Padding (px on each side)</span>
            <Input
              type="number"
              min={0}
              value={padding}
              onChange={(e) => setPadding(e.target.value)}
              className="h-8 w-24"
              aria-label="Padding in pixels"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includePredicted}
              onChange={(e) => setIncludePredicted(e.target.checked)}
            />
            Also box predicted instances (as predicted boxes)
          </label>
          <fieldset className="space-y-1">
            <label className="flex items-center gap-2">
              <input type="radio" name="bbox-scope" checked={scope === "frame"} onChange={() => setScope("frame")} />
              This frame ({counts.frame} box{counts.frame === 1 ? "" : "es"})
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="bbox-scope" checked={scope === "project"} onChange={() => setScope("project")} />
              Every frame ({counts.project} box{counts.project === 1 ? "" : "es"})
            </label>
          </fieldset>
          <p className="text-xs text-muted-foreground">The dashed outlines on the frame show this frame&apos;s boxes.</p>
          <p className="text-xs text-muted-foreground">
            {counts.drawnBoxes ? "This project already has drawn boxes. " : ""}
            Once a project has any drawn box, a box detector trains on drawn boxes only (sleap-nn&apos;s
            &quot;auto&quot; box source): frames you label later need boxes too, and animals left
            without a box on a boxed frame count as background.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={(scope === "frame" ? counts.frame : counts.project) === 0}>
            Add boxes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
