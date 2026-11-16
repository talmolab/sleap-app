/**
 * Labels › Bounding Boxes › Boxes from Poses (#488): add a padded box around
 * every user pose instance that has no box yet, on this frame or every frame.
 * While open, the boxes it would add on the current frame are previewed on the
 * canvas, updating with the padding.
 */
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { BboxesFromPoses, posesToBboxes } from "@/commands/bboxCommands";
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
  const [padding, setPadding] = useState("8");
  const [scope, setScope] = useState<"frame" | "project">("project");
  const pad = Math.max(-1000, Number(padding) || 0);

  // Live preview on the canvas while open.
  useEffect(() => {
    useAppStore.getState().set("bboxPosePreviewPadding", open ? pad : null);
  }, [open, pad]);

  const counts = useMemo(() => {
    if (!open || !labels) return { frame: 0, project: 0 };
    const frame = labeledFrame ? posesToBboxes(labeledFrame, pad).length : 0;
    let project = 0;
    for (const lf of labels.labeledFrames) project += posesToBboxes(lf, pad).length;
    return { frame, project };
  }, [open, labels, labeledFrame, pad]);

  const close = () => useAppStore.getState().set("bboxFromPosesOpen", false);
  const apply = async () => {
    await commandContext.execute(BboxesFromPoses, { padding: pad, scope });
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Boxes from Poses</DialogTitle>
          <DialogDescription>
            Adds a box around each user instance that doesn't have one, linked to it and on its track.
            These match the boxes sleap-nn makes from poses when a project has no boxes of its own.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>Padding (px on each side)</span>
            <Input
              type="number"
              value={padding}
              onChange={(e) => setPadding(e.target.value)}
              className="h-8 w-24"
              aria-label="Padding in pixels"
            />
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
          <p className="text-xs text-muted-foreground">The dashed outlines on the frame show this frame's boxes.</p>
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
