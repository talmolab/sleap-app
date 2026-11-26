/**
 * Delete Predictions Dialog.
 *
 * Provides multiple deletion strategies for predicted instances. Scopes match
 * PyQt SLEAP's commands of the same name (#463), and each option says its scope:
 * - Low score (this video)
 * - Outside a frame range (this video) — the range is what to keep
 * - On user-labeled frames (this video or all videos; unlinked or all)
 * - Beyond max instances per frame (this video)
 * - By track (all videos)
 * - By instance type (all videos)
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { confirmDialog } from "@/stores/confirmStore";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import { videoFrameCount } from "@/lib/inferFrameCount";
import {
  boxesBeyondMaxInstances,
  boxesOnTrack,
  boxesOnUserLabeledFrames,
  boxesOutsideFrameRange,
  boxesWithLowScore,
  predictionsBeyondMaxInstances,
  predictionsOnUserLabeledFrames,
  predictionsOutsideFrameRange,
  predictionsWithLowScore,
} from "@/lib/predictionDeletion";
import {
  DeletePredictionsByScore,
  DeletePredictionsByRange,
  DeletePredictionsOnLabeledFrames,
  DeletePredictionsByMaxCount,
  DeletePredictionsByTrack,
  DeleteInstancesByType,
} from "../../commands/fileCommands";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/NumberInput";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

type DeleteMode = "score" | "range" | "labeled" | "maxCount" | "track" | "type";

interface DeletePredictionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeletePredictionsDialog({
  open,
  onOpenChange,
}: DeletePredictionsDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const videoRevision = useAppStore((s) => s.videoRevision);
  // Same length the seekbar uses: the video's own frame count, or (when that
  // is unknown) up to its last labeled frame. Starting the kept range at 0-0
  // for an unknown-length video would delete nearly every prediction in it.
  const totalFrames = useMemo(
    () => (open ? videoFrameCount(labels, video) : 0),
    // videoRevision: a deferred backend opening corrects video.shape[0].
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, labels, video, videoRevision],
  );

  const [mode, setMode] = useState<DeleteMode>("score");
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(totalFrames > 0 ? totalFrames - 1 : 0);
  // An empty or reversed range would keep nothing; don't offer Delete for it.
  const rangeValid = totalFrames > 0 && rangeStart <= rangeEnd;
  const [maxCount, setMaxCount] = useState(2);
  const [labeledAllVideos, setLabeledAllVideos] = useState(false);
  const [unlinkedOnly, setUnlinkedOnly] = useState(true);

  // Reset the kept range to the whole video each time the dialog opens (or the
  // video changes): a stale range would delete everything outside it.
  useEffect(() => {
    if (!open) return;
    setRangeStart(0);
    setRangeEnd(totalFrames > 0 ? totalFrames - 1 : 0);
  }, [open, video, totalFrames]);
  const [selectedTrack, setSelectedTrack] = useState<string>("__untracked__");
  const [instanceType, setInstanceType] = useState<"predicted" | "user" | "all">("predicted");

  // Get available tracks
  const tracks = useMemo(() => labels?.tracks ?? [], [labels]);

  // Compute preview counts (instances, and predicted boxes from a box
  // detector) based on current filter settings
  const { count: previewCount, boxCount: previewBoxCount } = useMemo(() => {
    if (!labels) return { count: 0, boxCount: 0 };
    let count = 0;
    let boxCount = 0;

    switch (mode) {
      case "score":
        if (video) {
          count = predictionsWithLowScore(labels, video, scoreThreshold).length;
          boxCount = boxesWithLowScore(labels, video, scoreThreshold).length;
        }
        break;
      case "range":
        if (video) {
          count = predictionsOutsideFrameRange(labels, video, rangeStart, rangeEnd).length;
          boxCount = boxesOutsideFrameRange(labels, video, rangeStart, rangeEnd).length;
        }
        break;
      case "labeled":
        if (labeledAllVideos || video) {
          const scope = labeledAllVideos ? null : (video ?? null);
          count = predictionsOnUserLabeledFrames(labels, scope, unlinkedOnly).length;
          boxCount = boxesOnUserLabeledFrames(labels, scope, unlinkedOnly).length;
        }
        break;
      case "maxCount":
        if (video) {
          count = predictionsBeyondMaxInstances(labels, video, maxCount).length;
          boxCount = boxesBeyondMaxInstances(labels, video, maxCount).length;
        }
        break;
      case "track": {
        const trackName = selectedTrack === "__untracked__" ? null : selectedTrack;
        boxCount = boxesOnTrack(labels, trackName).length;
        for (const lf of labels.labeledFrames) {
          for (const inst of lf.instances) {
            if (!(inst instanceof PredictedInstance)) continue;
            if (trackName === null) {
              if (inst.track === null) count++;
            } else {
              if (inst.track?.name === trackName) count++;
            }
          }
        }
        break;
      }
      case "type":
        for (const lf of labels.labeledFrames) {
          if (instanceType !== "user") boxCount += lf.bboxes.filter((b) => b.isPredicted).length;
          for (const inst of lf.instances) {
            if (instanceType === "predicted" && inst instanceof PredictedInstance) {
              count++;
            } else if (instanceType === "user" && !(inst instanceof PredictedInstance)) {
              count++;
            } else if (instanceType === "all") {
              count++;
            }
          }
        }
        break;
    }

    return { count, boxCount };
  }, [labels, video, mode, scoreThreshold, rangeStart, rangeEnd, maxCount, selectedTrack, instanceType, labeledAllVideos, unlinkedOnly]);

  const handleDelete = useCallback(async () => {
    // Double-confirm for "all" type deletion
    if (mode === "type" && instanceType === "all") {
      const ok = await confirmDialog({
        title: "Delete all instances",
        message: "This will delete ALL instances (both predicted and user-labeled). This cannot be easily undone. Are you sure?",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
    }

    switch (mode) {
      case "score":
        await commandContext.execute(DeletePredictionsByScore, {
          threshold: scoreThreshold,
        });
        break;
      case "range":
        await commandContext.execute(DeletePredictionsByRange, {
          startFrame: rangeStart,
          endFrame: rangeEnd,
        });
        break;
      case "labeled":
        await commandContext.execute(DeletePredictionsOnLabeledFrames, {
          allVideos: labeledAllVideos,
          unlinkedOnly,
        });
        break;
      case "maxCount":
        await commandContext.execute(DeletePredictionsByMaxCount, {
          maxInstances: maxCount,
        });
        break;
      case "track":
        await commandContext.execute(DeletePredictionsByTrack, {
          trackName: selectedTrack === "__untracked__" ? null : selectedTrack,
        });
        break;
      case "type":
        await commandContext.execute(DeleteInstancesByType, {
          instanceType,
        });
        break;
    }
    onOpenChange(false);
  }, [mode, scoreThreshold, rangeStart, rangeEnd, maxCount, selectedTrack, instanceType, labeledAllVideos, unlinkedOnly, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete Predictions</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Deletion method</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as DeleteMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="score">With low score (this video)</SelectItem>
                <SelectItem value="range">Outside a frame range (this video)</SelectItem>
                <SelectItem value="labeled">On user-labeled frames</SelectItem>
                <SelectItem value="maxCount">Beyond max instances per frame (this video)</SelectItem>
                <SelectItem value="track">By track (all videos)</SelectItem>
                <SelectItem value="type">By instance type (all videos)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "score" && (
            <div className="space-y-2">
              <Label>
                Delete predictions with score below: {scoreThreshold.toFixed(2)}
              </Label>
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={[scoreThreshold]}
                onValueChange={([v]) => setScoreThreshold(v)}
              />
              <p className="text-xs text-muted-foreground">
                Predictions in the current video with an instance score below
                this threshold will be removed. Other videos are not changed.
              </p>
            </div>
          )}

          {mode === "range" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Keep from frame</Label>
                  <NumberInput
                    integer
                    min={0}
                    max={totalFrames > 0 ? totalFrames - 1 : undefined}
                    value={rangeStart}
                    onCommit={setRangeStart}
                  />
                </div>
                <div>
                  <Label>to frame</Label>
                  <NumberInput
                    integer
                    min={0}
                    max={totalFrames > 0 ? totalFrames - 1 : undefined}
                    value={rangeEnd}
                    onCommit={setRangeEnd}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Keeps predictions on frames {rangeStart} to {rangeEnd} (inclusive)
                and deletes the current video&apos;s predictions on every other
                frame. Other videos are not changed.
              </p>
              {!rangeValid && (
                <p className="text-xs text-destructive">
                  {totalFrames > 0
                    ? "The start frame must not be after the end frame."
                    : "This video's length is unknown, so no range can be kept."}
                </p>
              )}
            </div>
          )}

          {mode === "labeled" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Delete predictions on frames that already have user-labeled
                instances. This cleans up duplicates that appear when
                predictions are merged into frames with user labels.
              </p>
              <div className="space-y-1.5">
                <Label>Scope</Label>
                <RadioRow
                  name="labeledScope"
                  checked={!labeledAllVideos}
                  onChange={() => setLabeledAllVideos(false)}
                  label="Current video only"
                />
                <RadioRow
                  name="labeledScope"
                  checked={labeledAllVideos}
                  onChange={() => setLabeledAllVideos(true)}
                  label="All videos"
                />
              </div>
              <div className="space-y-1.5">
                <Label>What to delete</Label>
                <RadioRow
                  name="labeledWhat"
                  checked={unlinkedOnly}
                  onChange={() => setUnlinkedOnly(true)}
                  label="Unlinked predictions only (visible duplicates)"
                  title="Delete predictions that no user instance on the frame was made from. These are the ones shown as duplicates next to user instances."
                />
                <RadioRow
                  name="labeledWhat"
                  checked={!unlinkedOnly}
                  onChange={() => setUnlinkedOnly(false)}
                  label="All predictions on user-labeled frames"
                  title="Also delete the predictions user instances were made from (hidden behind them)."
                />
              </div>
            </div>
          )}

          {mode === "maxCount" && (
            <div className="space-y-2">
              <Label>Max predictions per frame: {maxCount}</Label>
              <NumberInput
                integer
                min={1}
                max={100}
                value={maxCount}
                onCommit={setMaxCount}
              />
              <p className="text-xs text-muted-foreground">
                On each frame of the current video, keep only the top {maxCount}{" "}
                predictions (by score) and remove the rest. Other videos are not
                changed.
              </p>
            </div>
          )}

          {mode === "track" && (
            <div className="space-y-2">
              <Label>Select track</Label>
              <Select value={selectedTrack} onValueChange={setSelectedTrack}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__untracked__">Untracked</SelectItem>
                  {tracks.map((track) => (
                    <SelectItem key={track.name} value={track.name}>
                      {track.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Delete all predicted instances on the selected track, in every
                video.
              </p>
            </div>
          )}

          {mode === "type" && (
            <div className="space-y-2">
              <Label>Instance type to delete</Label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="instanceType"
                    value="predicted"
                    checked={instanceType === "predicted"}
                    onChange={() => setInstanceType("predicted")}
                    className="accent-primary"
                  />
                  Predicted only
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="instanceType"
                    value="user"
                    checked={instanceType === "user"}
                    onChange={() => setInstanceType("user")}
                    className="accent-primary"
                  />
                  User only
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="instanceType"
                    value="all"
                    checked={instanceType === "all"}
                    onChange={() => setInstanceType("all")}
                    className="accent-primary"
                  />
                  All instances
                </label>
              </div>
              {instanceType === "all" && (
                <p className="text-xs text-destructive font-medium">
                  Warning: This will delete ALL instances including user labels.
                  A double-confirmation will be required.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Delete all instances of the selected type, on every frame of
                every video.
              </p>
            </div>
          )}

          {/* Preview count */}
          <div className="pt-2 border-t text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{previewCount}</span>{" "}
            instance{previewCount !== 1 ? "s" : ""}
            {previewBoxCount > 0 && (
              <>
                {" "}and <span className="font-medium text-foreground">{previewBoxCount}</span>{" "}
                predicted box{previewBoxCount !== 1 ? "es" : ""}
              </>
            )}{" "}
            will be deleted
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={previewCount + previewBoxCount === 0 || (mode === "range" && !rangeValid)}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One radio button with its label (and optional hover explanation). */
function RadioRow({
  name,
  checked,
  onChange,
  label,
  title,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer" title={title}>
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="accent-primary"
      />
      {label}
    </label>
  );
}
