/**
 * Shared staged-video list for the video-import flows (New Project dialog,
 * Videos panel "Add Videos"): one row per picked file with a filename, a
 * per-row "Grayscale" checkbox, a remove button, and "All grayscale"/"All RGB"
 * bulk-apply actions.
 *
 * Mirrors the legacy Qt GUI's "Import Videos" dialog (`sleap/gui/dialogs/
 * importvideos.py`): a per-file grayscale checkbox plus bulk "All grayscale"/
 * "All RGB" buttons. Unlike the Qt dialog, there is no retroactive toggle after
 * import — the checkbox state here is the only chance to set it, matching the
 * legacy behavior exactly (grayscale is a `Video` constructor-time choice).
 */

import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import type { PickedVideoFile } from "@/lib/resolveVideos";

/** A staged video plus the grayscale choice for it (defaults to `false` — RGB). */
export interface VideoImportEntry extends PickedVideoFile {
  grayscale: boolean;
}

/** Wrap freshly-picked files into staged entries, defaulting to RGB (unchecked). */
export function toVideoImportEntries(
  picked: PickedVideoFile[]
): VideoImportEntry[] {
  return picked.map((p) => ({ ...p, grayscale: false }));
}

interface VideoImportListProps {
  videos: VideoImportEntry[];
  onChange: (videos: VideoImportEntry[]) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
  /** Forwarded to the root list element (tutorial-step DOM hook). */
  "data-tutorial"?: string;
}

export function VideoImportList({
  videos,
  onChange,
  onRemove,
  disabled,
  ...rest
}: VideoImportListProps) {
  if (videos.length === 0) return null;

  const setGrayscale = (index: number, value: boolean) => {
    onChange(
      videos.map((v, i) => (i === index ? { ...v, grayscale: value } : v))
    );
  };
  const setAll = (value: boolean) => {
    onChange(videos.map((v) => ({ ...v, grayscale: value })));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {videos.length > 1 && (
        <div className="flex items-center gap-1 self-start">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => setAll(true)}
            disabled={disabled}
          >
            All grayscale
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => setAll(false)}
            disabled={disabled}
          >
            All RGB
          </Button>
        </div>
      )}
      <ul className="mt-1 flex flex-col gap-1" data-tutorial={rest["data-tutorial"]}>
        {videos.map((v, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">{v.file.name}</span>
            <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
              <Checkbox
                checked={v.grayscale}
                onCheckedChange={(checked) =>
                  setGrayscale(i, checked === true)
                }
                disabled={disabled}
                aria-label={`Import ${v.file.name} as grayscale`}
              />
              Grayscale
            </label>
            <button
              onClick={() => onRemove(i)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${v.file.name}`}
              disabled={disabled}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
