/**
 * Bounding boxes on the current frame (#488), listed under the instance table.
 * Click a row to select the box on the canvas; edit its category, track and
 * linked pose instance; delete it. Every edit is one undo step.
 */
import { useEffect, useState } from "react";
import { Check, Tag, X } from "lucide-react";
import { PredictedBoundingBox, type BoundingBox } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useSlpAccessNonce } from "@/stores/slpFormatStore";
import { commandContext, SetRecordMetadata } from "@/commands";
import { AcceptBbox, AcceptFrameBboxes, DeleteBbox, SetBboxProps } from "@/commands/bboxCommands";
import { isViewOnlyLabels, metadataOf } from "@/lib/slpFormat";
import {
  MetadataEditor,
  formatMetadataPreview,
} from "@/components/common/MetadataEditor";
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

/** Short label for a pose instance in a picker: "1 · fly_A". */
export function instanceOptionLabel(lf: LabeledFrame, idx: number): string {
  const inst = lf.instances[idx];
  const kind = inst instanceof Object && "score" in inst ? "pred" : "user";
  return `${idx + 1} · ${inst?.track?.name ?? kind}`;
}

/** Column headings, with a hover tip saying what each column is. */
const BBOX_COLUMNS: { label: string; tip: string; right?: boolean }[] = [
  { label: "#", tip: "Box number on this frame", right: true },
  { label: "Type", tip: "user: drawn or accepted by you. pred: predicted by a model" },
  { label: "Score", tip: "Prediction score (predicted boxes only)", right: true },
  { label: "Review", tip: "Accept (✓) turns a predicted box into a user box; ✕ rejects a predicted box or deletes a user box" },
  { label: "Category", tip: "The box's class, e.g. mouse. Used to train a multi-class detector" },
  { label: "Track", tip: "The animal's track. Sets the box's color" },
  { label: "Linked instance", tip: "The pose instance this box belongs to" },
];

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
      className="h-6 w-24 shrink-0 px-1.5 text-xs"
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
  // Re-render after in-place edits or view-only access toggle.
  useAppStore((s) => s.editSeq);
  useAppStore((s) => s.overlayVersion);
  useSlpAccessNonce((s) => s.nonce);
  const viewOnly = isViewOnlyLabels(labels);

  const boxes = labeledFrame?.bboxes ?? [];
  if (boxes.length === 0 && !bboxDrawMode) return null;
  const tracks = labels?.tracks ?? [];
  const selectedBox =
    selectedBboxIdx !== null && selectedBboxIdx >= 0 && selectedBboxIdx < boxes.length
      ? boxes[selectedBboxIdx]
      : null;
  const select = "h-6 shrink-0 rounded border border-input bg-background px-1 text-xs";

  return (
    <div className="shrink-0 border-t">
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        <span>Boxes ({boxes.length})</span>
        {bboxDrawMode && <span className="text-[11px]">Box tool on: drag on the frame</span>}
        <span className="ml-auto flex gap-1">
          {boxes.some((b) => b instanceof PredictedBoundingBox) && (
            <Button
              variant="subtle"
              size="xs"
              title="Turn every predicted box on this frame into a user box"
              onClick={() => commandContext.execute(AcceptFrameBboxes)}
            >
              Accept all
            </Button>
          )}
          {(labeledFrame?.userInstances.length ?? 0) > 0 && (
            <Button
              variant="subtle"
              size="xs"
              title="Add a box around each user instance"
              onClick={() => useAppStore.getState().set("bboxFromPosesOpen", true)}
            >
              From poses…
            </Button>
          )}
        </span>
      </div>
      {boxes.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">No boxes on this frame.</p>
      ) : (
        // Same scroll + sticky-header setup as the instance table above (the
        // overflow-visible override keeps Table's own wrapper from stealing
        // the sticky header's scroll container).
        <div className="max-h-48 overflow-auto pb-1 [&_[data-slot=table-container]]:overflow-visible">
          <Table className="min-w-max border-separate border-spacing-0">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                {BBOX_COLUMNS.map((c) => (
                  <TableHead
                    key={c.label || "review"}
                    title={c.tip}
                    className={cn("h-auto border-b px-1.5 py-1 text-xs font-normal", c.right && "text-right")}
                  >
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {boxes.map((box, i) => {
                const predicted = box instanceof PredictedBoundingBox;
                const linkedIdx = box.instance && labeledFrame ? labeledFrame.instances.indexOf(box.instance) : -1;
                const boxMetaPreview = formatMetadataPreview(metadataOf(box));
                return (
                  <TableRow
                    key={i}
                    aria-selected={selectedBboxIdx === i}
                    data-state={selectedBboxIdx === i ? "selected" : undefined}
                    className="cursor-pointer text-xs"
                    onClick={() => useAppStore.getState().set("selectedBboxIdx", i)}
                  >
                    <TableCell className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center justify-end gap-1">
                        {boxMetaPreview && (
                          <span
                            title={`Metadata: ${boxMetaPreview}`}
                            aria-label={`Box ${i + 1} has metadata`}
                            className="inline-flex text-muted-foreground"
                          >
                            <Tag className="h-2.5 w-2.5" />
                          </span>
                        )}
                        {i + 1}
                      </span>
                    </TableCell>
                    <TableCell className="px-1.5 py-0.5">{predicted ? "pred" : "user"}</TableCell>
                    <TableCell className="px-1.5 py-0.5 text-right tabular-nums">
                      {predicted ? (box as PredictedBoundingBox).score.toFixed(2) : "—"}
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <span className="flex items-center">
                        {predicted ? (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Accept box ${i + 1}`}
                            title="Accept: make it a user box"
                            onClick={(e) => {
                              e.stopPropagation();
                              commandContext.execute(AcceptBbox, { index: i });
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
                          aria-label={`${predicted ? "Reject" : "Delete"} box ${i + 1}`}
                          title={predicted ? "Reject: delete this predicted box" : "Delete box"}
                          onClick={(e) => {
                            e.stopPropagation();
                            commandContext.execute(DeleteBbox, { index: i });
                          }}
                        >
                          <X />
                        </Button>
                      </span>
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
                      <CategoryInput box={box} index={i} />
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
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
                    </TableCell>
                    <TableCell className="px-1 py-0.5">
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
                        <option value={-1}>none</option>
                        {labeledFrame?.instances.map((_, k) => (
                          <option key={k} value={k}>
                            {instanceOptionLabel(labeledFrame, k)}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {selectedBox && selectedBboxIdx !== null && (
        <div className="border-t border-border/50 px-2 py-1">
          <MetadataEditor
            label={`Box ${selectedBboxIdx + 1} metadata`}
            metadata={selectedBox.metadata}
            readOnly={viewOnly}
            testId="bbox-metadata"
            onChange={(next) => {
              void commandContext.execute(SetRecordMetadata, {
                target: "bbox",
                index: selectedBboxIdx,
                metadata: next,
              });
            }}
          />
        </div>
      )}
    </div>
  );
}
