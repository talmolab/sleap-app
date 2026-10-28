/**
 * Labels → Extract Clip and Labels / Extract Clip Labels Package options.
 *
 * PyQt parity: PyQt's Export Clip Options (`video_clip_form.yaml`) asks for the
 * clip's Frames Per Second (default: the video's) before writing it. This
 * dialog also shows the selected range and what it holds, and offers opening
 * the new project when done (PyQt always opens it). The menu items are only
 * enabled with a range selected on the seekbar, as in PyQt.
 */

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { isTauri } from "../../platform/index";
import { commandContext } from "../../commands/CommandContext";
import {
  ExtractClipAndLabelsCommand,
  ExtractClipLabelsPackageCommand,
  extractRange,
} from "../../commands/extractClipCommands";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TITLE = {
  clip: "Extract Clip and Labels",
  package: "Extract Clip Labels Package",
} as const;

const DESCRIPTION = {
  clip: "Save the selected frames as a new video, with a project whose labels are renumbered from frame 0 to match it.",
  package:
    "Save the selected range's labeled and suggested frames, with their images embedded, as a .pkg.slp that keeps the original frame numbers.",
} as const;

export function ExtractClipDialog() {
  const variant = useAppStore((s) => s.extractClipDialog);
  const setVariant = useAppStore((s) => s.setExtractClipDialog);
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const frameRange = useAppStore((s) => s.frameRange);

  const videoFps = video?.fps && video.fps > 0 ? Math.round(video.fps) : 30;
  const [fps, setFps] = useState(videoFps);
  const [openWhenDone, setOpenWhenDone] = useState(true);
  useEffect(() => {
    if (variant) setFps(videoFps);
  }, [variant, videoFps]);

  const range = video ? extractRange(frameRange, video) : null;
  const inRange = (v: unknown, f: number) =>
    v === video && !!range && f >= range.start && f <= range.end;
  const labeled = labels?.labeledFrames.filter((lf) => inRange(lf.video, lf.frameIdx)).length ?? 0;
  const suggested = labels?.suggestions.filter((s) => inRange(s.video, s.frameIdx)).length ?? 0;
  const fpsValid = Number.isFinite(fps) && fps >= 1 && fps <= 200;

  const handleExtract = useCallback(async () => {
    if (!variant) return;
    // Close first so the extract's progress overlay (below dialogs) shows.
    setVariant(null);
    await commandContext.execute(
      variant === "clip" ? ExtractClipAndLabelsCommand : ExtractClipLabelsPackageCommand,
      variant === "clip" ? { fps, openWhenDone } : { openWhenDone }
    );
  }, [variant, fps, openWhenDone, setVariant]);

  if (!variant) return null;

  return (
    <Dialog open={true} onOpenChange={(open) => !open && setVariant(null)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{TITLE[variant]}</DialogTitle>
          <DialogDescription className="text-xs">{DESCRIPTION[variant]}</DialogDescription>
        </DialogHeader>

        {range ? (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="font-medium">
              Frames {range.start.toLocaleString()}–{range.end.toLocaleString()} (
              {range.count.toLocaleString()} frame{range.count === 1 ? "" : "s"})
            </div>
            <div className="text-xs text-muted-foreground">
              {labeled} labeled, {suggested} suggested
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a frame range first: shift-drag on the seekbar.
          </p>
        )}

        <div className="space-y-3">
          {variant === "clip" && (
            <div className="space-y-1">
              <Label htmlFor="extract-fps">Frames per second</Label>
              <Input
                id="extract-fps"
                type="number"
                min={1}
                max={200}
                value={Number.isFinite(fps) ? fps : ""}
                onChange={(e) => setFps(parseInt(e.target.value, 10))}
                className="w-28"
              />
            </div>
          )}
          {isTauri && (
            <label htmlFor="extract-open" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="extract-open"
                checked={openWhenDone}
                onCheckedChange={(v) => setOpenWhenDone(v === true)}
              />
              Open the new project when done
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setVariant(null)}>
            Cancel
          </Button>
          <Button onClick={handleExtract} disabled={!range || (variant === "clip" && !fpsValid)}>
            Extract
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
