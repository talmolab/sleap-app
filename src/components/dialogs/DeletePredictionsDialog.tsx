/**
 * Delete Predictions Dialog.
 *
 * Provides multiple deletion strategies for predicted instances:
 * - By score threshold
 * - By frame range
 * - On user-labeled frames only
 * - By max instances per frame
 * - By track
 * - By instance type
 */

import { useState, useCallback, useMemo } from "react";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
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
import { Input } from "@/components/ui/input";
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
  const totalFrames = video?.shape?.[0] ?? 0;

  const [mode, setMode] = useState<DeleteMode>("score");
  const [scoreThreshold, setScoreThreshold] = useState(0.5);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(totalFrames > 0 ? totalFrames - 1 : 0);
  const [maxCount, setMaxCount] = useState(2);
  const [selectedTrack, setSelectedTrack] = useState<string>("__untracked__");
  const [instanceType, setInstanceType] = useState<"predicted" | "user" | "all">("predicted");

  // Get available tracks
  const tracks = useMemo(() => labels?.tracks ?? [], [labels]);

  // Compute preview count based on current filter settings
  const previewCount = useMemo(() => {
    if (!labels) return 0;
    let count = 0;

    switch (mode) {
      case "score":
        for (const lf of labels.labeledFrames) {
          for (const inst of lf.instances) {
            if (inst instanceof PredictedInstance && inst.score < scoreThreshold) {
              count++;
            }
          }
        }
        break;
      case "range":
        for (const lf of labels.labeledFrames) {
          if (lf.frameIdx >= rangeStart && lf.frameIdx <= rangeEnd) {
            for (const inst of lf.instances) {
              if (inst instanceof PredictedInstance) count++;
            }
          }
        }
        break;
      case "labeled":
        for (const lf of labels.labeledFrames) {
          const hasUser = lf.instances.some(
            (inst) => !(inst instanceof PredictedInstance)
          );
          if (hasUser) {
            for (const inst of lf.instances) {
              if (inst instanceof PredictedInstance) count++;
            }
          }
        }
        break;
      case "maxCount":
        for (const lf of labels.labeledFrames) {
          const predicted = lf.instances.filter(
            (inst) => inst instanceof PredictedInstance
          );
          if (predicted.length > maxCount) {
            count += predicted.length - maxCount;
          }
        }
        break;
      case "track": {
        const trackName = selectedTrack === "__untracked__" ? null : selectedTrack;
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

    return count;
  }, [labels, mode, scoreThreshold, rangeStart, rangeEnd, maxCount, selectedTrack, instanceType]);

  const handleDelete = useCallback(async () => {
    // Double-confirm for "all" type deletion
    if (mode === "type" && instanceType === "all") {
      if (!confirm("This will delete ALL instances (both predicted and user-labeled). This cannot be easily undone. Are you sure?")) {
        return;
      }
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
        await commandContext.execute(DeletePredictionsOnLabeledFrames);
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
  }, [mode, scoreThreshold, rangeStart, rangeEnd, maxCount, selectedTrack, instanceType, onOpenChange]);

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
                <SelectItem value="score">By score threshold</SelectItem>
                <SelectItem value="range">By frame range</SelectItem>
                <SelectItem value="labeled">On user-labeled frames</SelectItem>
                <SelectItem value="maxCount">By max instances per frame</SelectItem>
                <SelectItem value="track">By track</SelectItem>
                <SelectItem value="type">By instance type</SelectItem>
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
                Predictions with an instance score below this threshold will be removed.
              </p>
            </div>
          )}

          {mode === "range" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Start frame</Label>
                  <Input
                    type="number"
                    min={0}
                    max={totalFrames > 0 ? totalFrames - 1 : undefined}
                    value={rangeStart}
                    onChange={(e) => setRangeStart(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
                <div>
                  <Label>End frame</Label>
                  <Input
                    type="number"
                    min={0}
                    max={totalFrames > 0 ? totalFrames - 1 : undefined}
                    value={rangeEnd}
                    onChange={(e) => setRangeEnd(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Delete all predictions in frames {rangeStart} to {rangeEnd} (inclusive).
              </p>
            </div>
          )}

          {mode === "labeled" && (
            <p className="text-sm text-muted-foreground">
              Delete all predicted instances on frames that also contain
              user-labeled instances.
            </p>
          )}

          {mode === "maxCount" && (
            <div className="space-y-2">
              <Label>Max predictions per frame: {maxCount}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={maxCount}
                onChange={(e) => setMaxCount(parseInt(e.target.value, 10) || 1)}
              />
              <p className="text-xs text-muted-foreground">
                Keep only the top {maxCount} predictions per frame (by score),
                removing the rest.
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
                Delete all predicted instances on the selected track.
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
                Delete all instances of the selected type across all frames.
              </p>
            </div>
          )}

          {/* Preview count */}
          <div className="pt-2 border-t text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{previewCount}</span>{" "}
            instance{previewCount !== 1 ? "s" : ""} will be deleted
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={previewCount === 0}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
