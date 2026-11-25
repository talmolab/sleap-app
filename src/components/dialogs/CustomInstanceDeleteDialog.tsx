/**
 * Labels ▸ Custom Instance Delete... — PyQt SLEAP's `DeleteDialog`
 * (`sleap/gui/dialogs/delete.py`): "Delete [type] in [frames] with [track]",
 * with PyQt's option wording. Option rules live in `customInstanceDelete.ts`.
 */

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useCustomDeleteDialog } from "@/stores/customDeleteDialogStore";
import { commandContext } from "@/commands/CommandContext";
import { DeleteInstancesCustom } from "@/commands/customDeleteCommands";
import {
  INSTANCE_TYPE_OPTIONS,
  TRACK_ANY,
  TRACK_NONE,
  framesOptions,
  trackOptions,
  type CustomDeleteChoice,
  type FramesOption,
  type InstanceTypeOption,
} from "@/lib/customInstanceDelete";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";


/** One "Label  [menu]" row of PyQt's form. */
function Row({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[3rem_1fr] items-center gap-3">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o, i) => (
            <SelectItem key={`${i}:${o}`} value={String(i)}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CustomInstanceDeleteDialog() {
  const open = useCustomDeleteDialog((s) => s.open);
  const setOpen = useCustomDeleteDialog((s) => s.setOpen);
  const labels = useAppStore((s) => s.labels);
  const hasFrameRange = useAppStore((s) => s.frameRange !== null);

  const tracks = useMemo(() => (open && labels ? [...labels.tracks] : []), [open, labels]);
  const frames = framesOptions(labels?.videos.length ?? 0, hasFrameRange);
  const trackItems = trackOptions(tracks);

  // Selections are menu indexes (track names need not be unique). PyQt builds
  // a fresh dialog each time, so every open starts at the first option.
  const [typeIdx, setTypeIdx] = useState("0");
  const [framesIdx, setFramesIdx] = useState("0");
  const [trackIdx, setTrackIdx] = useState("0");
  useEffect(() => {
    if (open) {
      setTypeIdx("0");
      setFramesIdx("0");
      setTrackIdx("0");
    }
  }, [open]);

  const handleDelete = () => {
    const t = Number(trackIdx);
    const choice: CustomDeleteChoice = {
      instanceType: INSTANCE_TYPE_OPTIONS[Number(typeIdx)] as InstanceTypeOption,
      frames: (frames[Number(framesIdx)] ?? frames[0]) as FramesOption,
      track:
        trackItems.length === 0 || trackItems[t] === TRACK_ANY
          ? "any"
          : trackItems[t] === TRACK_NONE
            ? "none"
            : (tracks[t - 2] ?? "any"),
    };
    setOpen(false);
    void commandContext.execute(
      DeleteInstancesCustom,
      choice as unknown as Record<string, unknown>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Custom Instance Delete</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Row
            label="Delete"
            value={typeIdx}
            options={INSTANCE_TYPE_OPTIONS}
            onChange={setTypeIdx}
          />
          <Row label="in" value={framesIdx} options={frames} onChange={setFramesIdx} />
          {trackItems.length > 0 && (
            <Row label="with" value={trackIdx} options={trackItems} onChange={setTrackIdx} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
