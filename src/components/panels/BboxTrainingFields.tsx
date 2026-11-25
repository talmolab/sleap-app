/**
 * Box settings for the box-detector model types (`bbox`, `top_down_bbox`),
 * shared by the Training panel and the Full Configuration window.
 *
 * - Box source and padding: where the detector's ground-truth boxes come from
 *   (`data_config.bbox_source` / `bbox_padding`). A top-down-box pair must use
 *   the same values (sleap-nn derives the instance model's training boxes the
 *   same way), so an edit here sets them on every config of the pipeline.
 * - Box crops (top-down-box only): how the centered-instance model crops each
 *   animal (`preprocessing.crop_mode`, `crop_bbox_aspect`, `crop_bbox_padding`).
 */
import type { ConfigFile, ConfigHyperparams, ModelType, BboxSource, CropBboxAspect } from "@/stores/trainingStore";
import { NumberInput } from "@/components/NumberInput";
import { HintBubble } from "@/components/HintBubble";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const BBOX_SOURCE_OPTIONS: { value: BboxSource; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "bboxes", label: "Drawn boxes" },
  { value: "instances", label: "Boxes around poses" },
  { value: "masks", label: "Mask outlines" },
];

const CROP_ASPECT_OPTIONS: { value: CropBboxAspect; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "letterbox", label: "Letterbox" },
  { value: "stretch", label: "Stretch" },
];

export function BboxTrainingFields({
  modelType,
  configs,
  onUpdateSlot,
  disabled = false,
  size = "sm",
  boxSettingsLockedBy = null,
}: {
  modelType: ModelType;
  configs: ConfigFile[];
  onUpdateSlot: (slot: string, updates: Partial<ConfigHyperparams>) => void;
  disabled?: boolean;
  /** "sm" for the Training panel, "md" for the Full Configuration window. */
  size?: "sm" | "md";
  /** Set when a reused model fixes Box source / padding (lib/reuseTrainedModel.ts): those two are locked, with this as the reason. */
  boxSettingsLockedBy?: string | null;
}) {
  if (modelType !== "bbox" && modelType !== "top_down_bbox") return null;
  const detector = configs.find((c) => c.slot === "bbox");
  const instance = modelType === "top_down_bbox" ? configs.find((c) => c.slot === "centered_instance") : undefined;
  const source = detector ?? instance;
  if (!source) return null;
  const hp = source.hyperparams;
  const mismatch =
    !!detector &&
    !!instance &&
    (detector.hyperparams.bboxSource !== instance.hyperparams.bboxSource ||
      detector.hyperparams.bboxPadding !== instance.hyperparams.bboxPadding);

  const text = size === "sm" ? "text-[10px]" : "text-sm";
  const control = size === "sm" ? "h-6 text-[10px]" : "h-8 text-sm";
  const hint = (t: string) => (size === "sm" ? <HintBubble text={t} className="h-3 w-3" /> : <HintBubble text={t} />);
  const updateShared = (updates: Partial<ConfigHyperparams>) => {
    for (const cf of [detector, instance]) if (cf) onUpdateSlot(cf.slot, updates);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`${text} text-muted-foreground shrink-0 flex items-center gap-1`}>
          Box source
          {hint(
            "Where the detector's training boxes come from. Auto: the boxes drawn in this project if it has any, else a box around each labeled pose, else each mask's outline. A pose-only project needs no drawn boxes. With drawn boxes on only some frames, Auto trains on those frames alone; pick Boxes around poses to use every labeled frame.",
          )}
        </span>
        <Select
          value={hp.bboxSource}
          onValueChange={(v) => updateShared({ bboxSource: v as BboxSource })}
          disabled={disabled || !!boxSettingsLockedBy}
        >
          <SelectTrigger className={`${control} w-40`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {BBOX_SOURCE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`${text} text-muted-foreground shrink-0 flex items-center gap-1`}>
          Box padding (px)
          {hint(
            "Pixels added on every side of boxes made from poses or masks. Keypoints sit inside the animal's outline, so a few pixels make the box cover the whole animal. Never added to drawn boxes.",
          )}
        </span>
        <NumberInput
          min={0}
          step={1}
          value={hp.bboxPadding}
          onCommit={(n) => updateShared({ bboxPadding: n })}
          className={`${control} w-20`}
          disabled={disabled || !!boxSettingsLockedBy}
        />
      </div>
      {boxSettingsLockedBy && (
        <p className={`${text} text-muted-foreground`} data-testid="bbox-settings-locked">{boxSettingsLockedBy}</p>
      )}
      {mismatch && (
        <p className={`${text} text-yellow-400`}>
          The detector and the instance model were set up with different box settings; changing one here
          sets both.
        </p>
      )}
      {instance && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className={`${text} text-muted-foreground shrink-0 flex items-center gap-1`}>
              Instance crops
              {hint(
                "Box crops cut each animal's box (plus the margin below) and resize it to the crop size, so animals of different sizes fill the crop the same way. Fixed crops cut a fixed-size window centered on each box.",
              )}
            </span>
            <Select
              value={instance.hyperparams.cropMode}
              onValueChange={(v) => onUpdateSlot(instance.slot, { cropMode: v as "fixed" | "bbox" })}
              disabled={disabled}
            >
              <SelectTrigger className={`${control} w-40`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bbox">Box crops</SelectItem>
                <SelectItem value="fixed">Fixed size</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {instance.hyperparams.cropMode === "bbox" && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={`${text} text-muted-foreground shrink-0 flex items-center gap-1`}>
                  Crop shape
                  {hint(
                    "Square grows the box to a square on its longest side. Letterbox does the same but blanks the pixels outside the box. Stretch resizes the box to a square on each axis (distorts the animal's proportions).",
                  )}
                </span>
                <Select
                  value={instance.hyperparams.cropBboxAspect}
                  onValueChange={(v) => onUpdateSlot(instance.slot, { cropBboxAspect: v as CropBboxAspect })}
                  disabled={disabled}
                >
                  <SelectTrigger className={`${control} w-40`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CROP_ASPECT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={`${text} text-muted-foreground shrink-0 flex items-center gap-1`}>
                  Crop margin
                  {hint("Margin added on every side of the box before cropping, as a fraction of the box's longest side (0.1 = 10%).")}
                </span>
                <NumberInput
                  min={0}
                  max={2}
                  step={0.05}
                  value={instance.hyperparams.cropBboxPadding}
                  onCommit={(n) => onUpdateSlot(instance.slot, { cropBboxPadding: n })}
                  className={`${control} w-20`}
                  disabled={disabled}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
