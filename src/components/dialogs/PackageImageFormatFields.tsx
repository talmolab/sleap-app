/**
 * Frame format of a labels package export: PNG (lossless, the default) or
 * JPEG with a quality. Shared by the Export Labels Package and Extract Clip
 * Labels Package dialogs, which open on the user's last choice (persisted in
 * the app store) and remember the choice when they export.
 *
 * When the installed SLP library can't write JPEG frames, JPEG is disabled
 * with the reason and the dialogs export PNG, leaving the remembered choice
 * as it was.
 */

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import {
  DEFAULT_JPEG_QUALITY,
  MAX_JPEG_QUALITY,
  MIN_JPEG_QUALITY,
  normalizePackageImage,
  type PackageImageFormat,
  type PackageImageOptions,
} from "@/lib/packageImageFormat";
import { canWriteJpegFrames, JPEG_FRAMES_UNAVAILABLE } from "@/lib/slpFormatCompat";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";

/** Whether a quality typed into the field can be exported. */
export function isValidJpegQuality(quality: number): boolean {
  return (
    Number.isInteger(quality) && quality >= MIN_JPEG_QUALITY && quality <= MAX_JPEG_QUALITY
  );
}

/**
 * The dialog's frame format: the user's last choice each time `open` turns
 * true (PNG when JPEG can't be written), whether it can be exported, and
 * `remember`, which stores it as the last choice (call it on Export).
 */
export function usePackageImageChoice(open: boolean) {
  const [choice, setChoice] = useState<PackageImageOptions>(() => initialChoice());
  useEffect(() => {
    if (open) setChoice(initialChoice());
  }, [open]);
  const valid = choice.format === "png" || isValidJpegQuality(choice.quality);
  const remember = useCallback(() => {
    // Without JPEG the dialog could only show PNG: keep the user's choice for
    // a build that has it (web channels share their stored preferences).
    if (canWriteJpegFrames()) useAppStore.getState().setPackageImage(choice);
  }, [choice]);
  return { choice, setChoice, valid, remember };
}

function initialChoice(): PackageImageOptions {
  const { packageImageFormat, packageJpegQuality } = useAppStore.getState();
  const image = normalizePackageImage(packageImageFormat, packageJpegQuality);
  return canWriteJpegFrames() ? image : { ...image, format: "png" };
}

interface PackageImageFormatFieldsProps {
  value: PackageImageOptions;
  onChange: (value: PackageImageOptions) => void;
  /** Prefix for element ids, unique per dialog. */
  idPrefix: string;
}

export function PackageImageFormatFields({
  value,
  onChange,
  idPrefix,
}: PackageImageFormatFieldsProps) {
  const jpegAvailable = canWriteJpegFrames();
  const qualityId = `${idPrefix}-jpeg-quality`;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Frame images</div>
      <RadioGroup
        value={value.format}
        onValueChange={(v) => onChange({ ...value, format: v as PackageImageFormat })}
        className="flex flex-wrap items-center gap-x-5 gap-y-2"
        aria-label="Frame image format"
      >
        <label htmlFor={`${idPrefix}-format-png`} className="flex items-center gap-2 text-sm cursor-pointer">
          <RadioGroupItem value="png" id={`${idPrefix}-format-png`} />
          PNG (lossless)
        </label>
        <label
          htmlFor={`${idPrefix}-format-jpg`}
          className={`flex items-center gap-2 text-sm ${jpegAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
        >
          <RadioGroupItem value="jpg" id={`${idPrefix}-format-jpg`} disabled={!jpegAvailable} />
          JPEG
        </label>
      </RadioGroup>
      {value.format === "jpg" && (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={qualityId}>Quality</label>
          <Input
            id={qualityId}
            type="number"
            min={MIN_JPEG_QUALITY}
            max={MAX_JPEG_QUALITY}
            step={1}
            value={Number.isFinite(value.quality) ? value.quality : ""}
            // Number(), not parseInt: "80.5" or "1e2" must not pass as 80 or 1.
            onChange={(e) =>
              onChange({
                ...value,
                quality: e.target.value.trim() === "" ? Number.NaN : Number(e.target.value),
              })
            }
            aria-invalid={!isValidJpegQuality(value.quality)}
            className="h-8 w-20"
          />
        </div>
      )}
      {jpegAvailable ? (
        <p className="text-xs text-muted-foreground">
          JPEG is lossy: the stored frames differ slightly from the video, and the
          package is usually several times smaller. Quality {MIN_JPEG_QUALITY}–
          {MAX_JPEG_QUALITY} (default {DEFAULT_JPEG_QUALITY}). Frames a package
          already stores as JPEG stay JPEG with PNG chosen.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">JPEG: {JPEG_FRAMES_UNAVAILABLE}</p>
      )}
      {value.format === "jpg" && !isValidJpegQuality(value.quality) && (
        <p className="text-xs text-destructive">
          Enter a quality from {MIN_JPEG_QUALITY} to {MAX_JPEG_QUALITY}.
        </p>
      )}
    </div>
  );
}
