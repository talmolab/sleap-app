/**
 * Go ▸ Frame Step Sizes… — how many frames Ctrl+Left/Right ("medium step") and
 * Ctrl+Shift+Left/Right ("large step") jump. PyQt SLEAP's "medium step size" /
 * "large step size" preferences (`sleap/prefs.py`), which it only lets you
 * change by editing preferences.yaml.
 */

import { useState, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { DEFAULT_SHORTCUTS, STEP_SIZES, MAX_STEP_SIZE } from "@/lib/shortcuts";
import { formatShortcut } from "@/lib/formatShortcut";
import { parseStepSize } from "@/lib/preferences";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

const keysFor = (next: string, prev: string) =>
  `${formatShortcut(DEFAULT_SHORTCUTS[next])} / ${formatShortcut(DEFAULT_SHORTCUTS[prev])}`;

export function FrameStepSizesDialog() {
  const open = useAppStore((s) => s.frameStepSizesDialogOpen);
  const [medium, setMedium] = useState("");
  const [large, setLarge] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setOpen = useCallback((value: boolean) => {
    useAppStore.getState().set("frameStepSizesDialogOpen", value);
  }, []);

  // Seed the fields from the current preferences each time the dialog opens.
  const [seeded, setSeeded] = useState(false);
  if (open && !seeded) {
    const s = useAppStore.getState();
    setMedium(String(s.mediumStepSize));
    setLarge(String(s.largeStepSize));
    setError(null);
    setSeeded(true);
  } else if (!open && seeded) {
    setSeeded(false);
  }

  const handleSave = useCallback(() => {
    const m = parseStepSize(medium);
    const l = parseStepSize(large);
    if (m === null || l === null) {
      setError(`Enter whole numbers of frames from 1 to ${MAX_STEP_SIZE.toLocaleString()}.`);
      return;
    }
    const store = useAppStore.getState();
    store.set("mediumStepSize", m);
    store.set("largeStepSize", l);
    setOpen(false);
  }, [medium, large, setOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>Frame Step Sizes</DialogTitle>
          <DialogDescription>How many frames the step shortcuts jump.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[1fr_7rem] items-center gap-x-3 gap-y-2 py-2">
          <Label htmlFor="medium-step-size" className="flex-col items-start gap-1">
            Medium step
            <span className="text-xs font-normal text-muted-foreground">
              {keysFor("frame next medium step", "frame prev medium step")}
            </span>
          </Label>
          <Input
            id="medium-step-size"
            type="number"
            min={1}
            max={MAX_STEP_SIZE}
            step={1}
            value={medium}
            onChange={(e) => {
              setMedium(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <Label htmlFor="large-step-size" className="flex-col items-start gap-1">
            Large step
            <span className="text-xs font-normal text-muted-foreground">
              {keysFor("frame next large step", "frame prev large step")}
            </span>
          </Label>
          <Input
            id="large-step-size"
            type="number"
            min={1}
            max={MAX_STEP_SIZE}
            step={1}
            value={large}
            onChange={(e) => {
              setLarge(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              setMedium(String(STEP_SIZES.medium));
              setLarge(String(STEP_SIZES.large));
              setError(null);
            }}
          >
            Defaults
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>OK</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
