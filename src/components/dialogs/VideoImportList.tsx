/**
 * Shared staged-video list for the video-import flows (New Project dialog,
 * Videos panel "Add Videos"): one row per picked file with a filename, its
 * import options, and a remove button, plus bulk-apply actions.
 *
 * Mirrors the legacy Qt GUI's "Import Videos" dialog (`sleap/gui/dialogs/
 * importvideos.py`):
 * - media files: a per-file "Grayscale" checkbox, bulk "All grayscale" /
 *   "All RGB" (it can also be flipped later with Videos ▸ Toggle Grayscale);
 * - raw HDF5 movies (`.h5`/`.hdf5`): a menu of the file's rank-4 datasets and
 *   a `channels_first` / `channels_last` choice (PyQt's labels, verbatim; the
 *   first is selected by default, as in PyQt), bulk "All channels last" /
 *   "All channels first".
 * Like PyQt, each pair of bulk buttons shows whenever a file of its kind is
 * staged, even just one.
 */

import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import type { Hdf5ImportOptions, PickedVideoFile } from "@/lib/resolveVideos";
import { HDF5_MOVIE_IMPORT_EXTS } from "@/lib/resolveVideos";
import { listRawMovieDatasets } from "@/lib/hdf5VideoSource";
import { HDF5_INPUT_FORMATS, type Hdf5InputFormat } from "@/lib/rawHdf5Video";

/** A raw HDF5 movie's import choices (PyQt's `dataset` + `input_format`). */
export interface Hdf5ImportChoice {
  /** The file's rank-4 datasets (PyQt's dataset menu). */
  datasets: string[];
  dataset: string;
  inputFormat: Hdf5InputFormat;
}

/** A staged video plus the grayscale choice for it (defaults to `false` — RGB). */
export interface VideoImportEntry extends PickedVideoFile {
  grayscale: boolean;
  /** Set for a raw HDF5 movie: these replace the grayscale checkbox. */
  hdf5?: Hdf5ImportChoice;
}

/** Wrap freshly-picked files into staged entries, defaulting to RGB (unchecked). */
export function toVideoImportEntries(
  picked: PickedVideoFile[]
): VideoImportEntry[] {
  return picked.map((p) => ({ ...p, grayscale: false }));
}

/** Is this a raw HDF5 movie file (`.h5`/`.hdf5`)? */
export function isHdf5MovieFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.includes(".") && HDF5_MOVIE_IMPORT_EXTS.includes(ext);
}

/**
 * Stage picked files, reading each HDF5 file's rank-4 datasets for its menu
 * (PyQt's `_get_h5_dataset_options`). The first dataset and `channels_first`
 * start selected, as in PyQt. An HDF5 file with no rank-4 dataset (e.g. a
 * SLEAP package) gets no menu and imports as before (auto-detected dataset).
 */
export async function prepareVideoImportEntries(
  picked: PickedVideoFile[],
  listDatasets: (
    file: File,
    absPath: string | null
  ) => Promise<string[]> = listRawMovieDatasets
): Promise<VideoImportEntry[]> {
  return Promise.all(
    toVideoImportEntries(picked).map(async (entry) => {
      if (!isHdf5MovieFile(entry.file.name)) return entry;
      const datasets = await listDatasets(entry.file, entry.absPath);
      if (datasets.length === 0) return entry;
      return {
        ...entry,
        hdf5: {
          datasets,
          dataset: datasets[0]!,
          inputFormat: HDF5_INPUT_FORMATS[0]!,
        },
      };
    })
  );
}

/**
 * The grayscale flag to import `entry` with: the checkbox for a media file;
 * `null` (autodetect from the first frame) for an HDF5 movie, whose PyQt
 * import has no grayscale parameter, so Python opens it with `grayscale=None`.
 */
export function importGrayscale(entry: VideoImportEntry): boolean | null {
  return entry.hdf5 ? null : entry.grayscale;
}

/** The HDF5 options to import `entry` with, or undefined for other files. */
export function hdf5ImportOptions(
  entry: VideoImportEntry
): Hdf5ImportOptions | undefined {
  return entry.hdf5
    ? { dataset: entry.hdf5.dataset, inputFormat: entry.hdf5.inputFormat }
    : undefined;
}

/** "All channels last" / "All channels first": set every HDF5 row. */
export function setAllInputFormats(
  videos: VideoImportEntry[],
  inputFormat: Hdf5InputFormat
): VideoImportEntry[] {
  return videos.map((v) =>
    v.hdf5 ? { ...v, hdf5: { ...v.hdf5, inputFormat } } : v
  );
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

  const update = (index: number, patch: Partial<VideoImportEntry>) => {
    onChange(videos.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };
  const setGrayscale = (index: number, value: boolean) =>
    update(index, { grayscale: value });
  const setHdf5 = (index: number, patch: Partial<Hdf5ImportChoice>) => {
    const hdf5 = videos[index]?.hdf5;
    if (hdf5) update(index, { hdf5: { ...hdf5, ...patch } });
  };
  const setAll = (value: boolean) => {
    onChange(videos.map((v) => (v.hdf5 ? v : { ...v, grayscale: value })));
  };

  const anyMedia = videos.some((v) => !v.hdf5);
  const anyHdf5 = videos.some((v) => v.hdf5);
  const bulkButton = "h-7 px-2.5 text-sm text-muted-foreground";

  return (
    <div className="flex flex-col gap-1.5">
      {/* PyQt shows the bulk buttons whenever a file of that kind is staged,
          even a single one. */}
      {(anyMedia || anyHdf5) && (
        <div className="flex flex-wrap items-center gap-2 self-start">
          {anyMedia && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButton}
                onClick={() => setAll(true)}
                disabled={disabled}
              >
                All grayscale
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButton}
                onClick={() => setAll(false)}
                disabled={disabled}
              >
                All RGB
              </Button>
            </>
          )}
          {anyHdf5 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButton}
                onClick={() =>
                  onChange(setAllInputFormats(videos, "channels_last"))
                }
                disabled={disabled}
              >
                All channels last
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={bulkButton}
                onClick={() =>
                  onChange(setAllInputFormats(videos, "channels_first"))
                }
                disabled={disabled}
              >
                All channels first
              </Button>
            </>
          )}
        </div>
      )}
      <ul className="mt-1 flex flex-col gap-1.5" data-tutorial={rest["data-tutorial"]}>
        {videos.map((v, i) => (
          <li
            key={i}
            className="flex flex-col gap-1.5 rounded bg-muted/40 px-2.5 py-1.5 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate">{v.file.name}</span>
              {!v.hdf5 && (
                <label className="flex shrink-0 items-center gap-2 font-medium">
                  <Checkbox
                    className="h-4.5 w-4.5"
                    checked={v.grayscale}
                    onCheckedChange={(checked) =>
                      setGrayscale(i, checked === true)
                    }
                    disabled={disabled}
                    aria-label={`Import ${v.file.name} as grayscale`}
                  />
                  Grayscale
                </label>
              )}
              <button
                onClick={() => onRemove(i)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${v.file.name}`}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {v.hdf5 && (
              <div className="flex flex-col gap-1">
                <select
                  className="h-7 w-full rounded border border-input bg-background px-1.5 text-sm"
                  value={v.hdf5.dataset}
                  onChange={(e) => setHdf5(i, { dataset: e.target.value })}
                  disabled={disabled}
                  aria-label={`Dataset in ${v.file.name}`}
                >
                  {v.hdf5.datasets.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <div
                  role="radiogroup"
                  aria-label={`Channel order of ${v.file.name}`}
                  className="flex flex-col gap-0.5"
                >
                  {HDF5_INPUT_FORMATS.map((fmt) => (
                    <label key={fmt} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`input-format-${i}`}
                        value={fmt}
                        checked={v.hdf5!.inputFormat === fmt}
                        onChange={() => setHdf5(i, { inputFormat: fmt })}
                        disabled={disabled}
                      />
                      {fmt}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
