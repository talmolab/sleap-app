/**
 * Segmentation masks on the current frame (#155), listed under the box table.
 *
 * Works like the mask / ROI lists in the vibes apps (sam3-segmenter,
 * labelroi): each row has the mask's canvas color, an editable name, and a
 * delete button; hovering a row highlights the mask on the canvas; clicking
 * selects it (click again to deselect). As in labelroi, each polygon is its
 * own mask; with a mask selected, Shift adds a polygon to it and Alt cuts.
 * As in sam3-segmenter, a mask can start a new object track.
 * Also, like the box list: category, track, linked pose instance, and accept /
 * reject for predicted masks. Every edit is one undo step.
 */
import { useEffect, useState } from "react";
import { Check, Pentagon, X } from "lucide-react";
import { PredictedSegmentationMask, type SegmentationMask } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { AcceptMask, AddMaskTrack, DeleteMask, SetMaskProps } from "@/commands/maskCommands";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { LabeledFrame } from "../../types";
import { instanceOptionLabel } from "./BboxList";

/** Column headings, with a hover tip saying what each column is. */
const MASK_COLUMNS: { label: string; tip: string; right?: boolean }[] = [
  { label: "#", tip: "Mask number on this frame, in its canvas color", right: true },
  { label: "Name", tip: "The mask's name, e.g. which animal or object it is" },
  { label: "Type", tip: "user: drawn or accepted by you. pred: predicted by a model" },
  { label: "Score", tip: "Prediction score (predicted masks only)", right: true },
  { label: "Review", tip: "Accept (✓) turns a predicted mask into a user mask; ✕ rejects a predicted mask or deletes a user mask" },
  { label: "Category", tip: "The mask's class, e.g. mouse" },
  { label: "Track", tip: "The object's track across frames. Sets the mask's color. \"New track\" starts a new object" },
  { label: "Linked instance", tip: "The pose instance this mask belongs to" },
  { label: "Area", tip: "Size in image pixels", right: true },
];

/** Text cell edited in place; commits on Enter / blur, Esc reverts. */
function EditableText({
  value,
  placeholder,
  label,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      className="h-6 w-24 shrink-0 px-1.5 text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Mask area in image pixels (mask pixels / scale²). */
export function maskImageArea(mask: SegmentationMask): number {
  return Math.round(mask.area / (mask.scale[0] * mask.scale[1]));
}

/** What the next polygon will do, shown above the list while the tool is on. */
export function polygonHint(selected: number | null): string {
  return selected === null
    ? "Polygon tool on: each polygon is a new mask"
    : `Each polygon is a new mask; Shift adds to mask ${selected + 1}, Alt cuts from it`;
}

const NEW_TRACK = -2;

export function MaskList({ labeledFrame }: { labeledFrame: LabeledFrame | null }) {
  const labels = useAppStore((s) => s.labels);
  const selectedMaskIdx = useAppStore((s) => s.selectedMaskIdx);
  const maskPolygonMode = useAppStore((s) => s.maskPolygonMode);
  const swatches = useAppStore((s) => s.maskSwatches);
  // Re-render after in-place edits.
  useAppStore((s) => s.editSeq);
  useAppStore((s) => s.overlayVersion);

  const masks = labeledFrame?.masks ?? [];
  if (masks.length === 0 && !maskPolygonMode) return null;
  const tracks = labels?.tracks ?? [];
  const select = "h-6 shrink-0 rounded border border-input bg-background px-1 text-xs";
  const setHover = (i: number | null) => useAppStore.getState().set("hoveredMaskIdx", i);

  return (
    <div className="shrink-0 border-t">
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        <span>Masks ({masks.length})</span>
        {maskPolygonMode && <span className="truncate text-[11px]">{polygonHint(selectedMaskIdx)}</span>}
        <span className="ml-auto flex gap-1">
          <Button
            variant={maskPolygonMode ? "default" : "subtle"}
            size="xs"
            aria-pressed={maskPolygonMode}
            title="Polygon tool (L): click points on the frame to draw a mask"
            onClick={() => useAppStore.getState().toggle("maskPolygonMode")}
          >
            <Pentagon /> Draw
          </Button>
        </span>
      </div>
      {masks.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">No masks on this frame.</p>
      ) : (
        <div
          className="max-h-48 overflow-auto pb-1 [&_[data-slot=table-container]]:overflow-visible"
          onMouseLeave={() => setHover(null)}
        >
          <Table className="min-w-max border-separate border-spacing-0">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                {MASK_COLUMNS.map((c) => (
                  <TableHead
                    key={c.label}
                    title={c.tip}
                    className={cn("h-auto border-b px-1.5 py-1 text-xs font-normal", c.right && "text-right")}
                  >
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {masks.map((mask, i) => {
                const predicted = mask instanceof PredictedSegmentationMask;
                const linkedIdx = mask.instance && labeledFrame ? labeledFrame.instances.indexOf(mask.instance) : -1;
                const color = swatches[i];
                return (
                  <TableRow
                    key={i}
                    aria-selected={selectedMaskIdx === i}
                    data-state={selectedMaskIdx === i ? "selected" : undefined}
                    className="cursor-pointer text-xs"
                    onMouseEnter={() => setHover(i)}
                    onClick={() =>
                      useAppStore.getState().set("selectedMaskIdx", selectedMaskIdx === i ? null : i)
                    }
                  >
                    <TableCell className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <span
                          aria-hidden
                          data-testid={`mask-swatch-${i}`}
                          className="inline-block size-2.5 rounded-sm border border-black/20"
                          style={{ background: color ? `rgb(${color.join(", ")})` : "transparent" }}
                        />
                        {i + 1}
                      </span>
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <EditableText
                        value={mask.name}
                        placeholder="name"
                        label={`Mask ${i + 1} name`}
                        onCommit={(name) => commandContext.execute(SetMaskProps, { index: i, name })}
                      />
                    </TableCell>
                    <TableCell className="px-1.5 py-0.5">{predicted ? "pred" : "user"}</TableCell>
                    <TableCell className="px-1.5 py-0.5 text-right tabular-nums">
                      {predicted ? (mask as PredictedSegmentationMask).score.toFixed(2) : "—"}
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <span className="flex items-center">
                        {predicted ? (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Accept mask ${i + 1}`}
                            title="Accept: make it a user mask"
                            onClick={(e) => {
                              e.stopPropagation();
                              commandContext.execute(AcceptMask, { index: i });
                            }}
                          >
                            <Check />
                          </Button>
                        ) : (
                          <span className="w-6" />
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${predicted ? "Reject" : "Delete"} mask ${i + 1}`}
                          title={predicted ? "Reject: delete this predicted mask" : "Delete mask"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setHover(null);
                            commandContext.execute(DeleteMask, { index: i });
                          }}
                        >
                          <X />
                        </Button>
                      </span>
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <EditableText
                        value={mask.category}
                        placeholder="category"
                        label={`Mask ${i + 1} category`}
                        onCommit={(category) => commandContext.execute(SetMaskProps, { index: i, category })}
                      />
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <select
                        aria-label={`Mask ${i + 1} track`}
                        className={select}
                        value={mask.track ? tracks.indexOf(mask.track) : -1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const t = Number(e.target.value);
                          if (t === NEW_TRACK) commandContext.execute(AddMaskTrack, { index: i });
                          else commandContext.execute(SetMaskProps, { index: i, track: t >= 0 ? tracks[t] : null });
                        }}
                      >
                        <option value={-1}>no track</option>
                        {tracks.map((t, ti) => (
                          <option key={ti} value={ti}>
                            {t.name}
                          </option>
                        ))}
                        <option value={NEW_TRACK}>+ New track</option>
                      </select>
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <select
                        aria-label={`Mask ${i + 1} linked instance`}
                        className={select}
                        value={linkedIdx}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const k = Number(e.target.value);
                          commandContext.execute(SetMaskProps, {
                            index: i,
                            instance: k >= 0 && labeledFrame ? labeledFrame.instances[k] : null,
                          });
                        }}
                      >
                        <option value={-1}>none</option>
                        {labeledFrame?.instances.map((_, k) => (
                          <option key={k} value={k}>
                            {instanceOptionLabel(labeledFrame, k)}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell className="px-1.5 py-0.5 text-right tabular-nums">
                      {maskImageArea(mask).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
