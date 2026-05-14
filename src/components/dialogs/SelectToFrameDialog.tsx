import { useState, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SelectToFrameDialog() {
  const open = useAppStore((s) => s.selectToFrameDialogOpen);
  const setOpen = useAppStore((s) => s.setSelectToFrameDialogOpen);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const video = useAppStore((s) => s.video);

  const [value, setValue] = useState("");

  const totalFrames = video?.shape?.[0] ?? null;
  const maxFrame = totalFrames !== null ? totalFrames - 1 : null;

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        setValue(String(frameIdx));
      }
      setOpen(newOpen);
    },
    [frameIdx, setOpen]
  );

  const handleSubmit = useCallback(() => {
    const target = parseInt(value, 10);
    if (isNaN(target) || target < 0) return;
    const clamped = maxFrame !== null ? Math.min(target, maxFrame) : target;
    const start = Math.min(frameIdx, clamped);
    const end = Math.max(frameIdx, clamped);
    useAppStore.getState().set("frameRange", [start, end] as [number, number]);
    setOpen(false);
  }, [value, frameIdx, maxFrame, setOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[300px]">
        <DialogHeader>
          <DialogTitle>Select to Frame</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <p className="text-xs text-muted-foreground mb-2">
            Select frames from current ({frameIdx}) to:
          </p>
          <Input
            type="number"
            min={0}
            max={maxFrame ?? undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Frame number (0${maxFrame !== null ? `-${maxFrame}` : ""})`}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>Select</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
