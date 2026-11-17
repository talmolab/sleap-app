/**
 * Bounding boxes on the current frame (#488), listed under the instance table.
 * Click a row to select the box on the canvas; edit its category, track and
 * linked pose instance; delete it. Every edit is one undo step.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { PredictedBoundingBox, type BoundingBox } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { DeleteBbox, SetBboxProps } from "@/commands/bboxCommands";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LabeledFrame } from "../../types";

/** Short label for a pose instance in a picker: "1 · fly_A". */
export function instanceOptionLabel(lf: LabeledFrame, idx: number): string {
  const inst = lf.instances[idx];
  const kind = inst instanceof Object && "score" in inst ? "pred" : "user";
  return `${idx + 1} · ${inst?.track?.name ?? kind}`;
}

function CategoryInput({ box, index }: { box: BoundingBox; index: number }) {
  const [value, setValue] = useState(box.category);
  useEffect(() => setValue(box.category), [box, box.category]);
  const commit = () => {
    if (value.trim() !== box.category) {
      commandContext.execute(SetBboxProps, { index, category: value });
    }
  };
  return (
    <Input
      value={value}
      placeholder="category"
      aria-label={`Box ${index + 1} category`}
      className="h-6 w-24 px-1.5 text-xs"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setValue(box.category);
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function BboxList({ labeledFrame }: { labeledFrame: LabeledFrame | null }) {
  const labels = useAppStore((s) => s.labels);
  const selectedBboxIdx = useAppStore((s) => s.selectedBboxIdx);
  const bboxDrawMode = useAppStore((s) => s.bboxDrawMode);
  // Re-render after in-place edits.
  useAppStore((s) => s.editSeq);
  useAppStore((s) => s.overlayVersion);

  const boxes = labeledFrame?.bboxes ?? [];
  if (boxes.length === 0 && !bboxDrawMode) return null;
  const tracks = labels?.tracks ?? [];
  const select = "h-6 rounded border border-input bg-background px-1 text-xs";

  return (
    <div className="shrink-0 border-t">
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        <span>Boxes ({boxes.length})</span>
        {bboxDrawMode && <span className="text-[11px]">Box tool on: drag on the frame</span>}
      </div>
      {boxes.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">No boxes on this frame.</p>
      ) : (
        <div className="max-h-48 overflow-auto pb-1">
          {boxes.map((box, i) => {
            const predicted = box instanceof PredictedBoundingBox;
            const linkedIdx = box.instance && labeledFrame ? labeledFrame.instances.indexOf(box.instance) : -1;
            return (
              <div
                key={i}
                role="row"
                aria-selected={selectedBboxIdx === i}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 text-xs cursor-pointer hover:bg-muted/60",
                  selectedBboxIdx === i && "bg-muted",
                )}
                onClick={() => useAppStore.getState().set("selectedBboxIdx", i)}
              >
                <span className="w-4 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="w-9">{predicted ? "pred" : "user"}</span>
                <span className="w-9 text-right tabular-nums">
                  {predicted ? (box as PredictedBoundingBox).score.toFixed(2) : "—"}
                </span>
                <CategoryInput box={box} index={i} />
                <select
                  aria-label={`Box ${i + 1} track`}
                  className={select}
                  value={box.track ? tracks.indexOf(box.track) : -1}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    commandContext.execute(SetBboxProps, { index: i, track: t >= 0 ? tracks[t] : null });
                  }}
                >
                  <option value={-1}>no track</option>
                  {tracks.map((t, ti) => (
                    <option key={ti} value={ti}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Box ${i + 1} linked instance`}
                  className={select}
                  value={linkedIdx}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const k = Number(e.target.value);
                    commandContext.execute(SetBboxProps, {
                      index: i,
                      instance: k >= 0 && labeledFrame ? labeledFrame.instances[k] : null,
                    });
                  }}
                >
                  <option value={-1}>no instance</option>
                  {labeledFrame?.instances.map((_, k) => (
                    <option key={k} value={k}>
                      {instanceOptionLabel(labeledFrame, k)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete box ${i + 1}`}
                  className="ml-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    commandContext.execute(DeleteBbox, { index: i });
                  }}
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
