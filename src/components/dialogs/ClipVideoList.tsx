/**
 * Video list for the Export Clips dialog: an include checkbox + click-to-focus
 * row per video, with a range summary and a select-all/none header. Focus (which
 * video the preview + settings show) is independent of inclusion (the checkbox).
 */
import type { Video } from "../../types";
import type { ClipConfig, ClipJobStatus } from "@/lib/videoExport";
import { cn } from "@/lib/utils";

/** Per-video runtime status shown on the right of each row during a batch export. */
export interface ClipJobInfo {
  status: ClipJobStatus;
  progress?: { done: number; total: number };
}

function jobIndicator(job: ClipJobInfo): { text: string; cls: string } {
  switch (job.status) {
    case "encoding": {
      const p =
        job.progress && job.progress.total
          ? Math.round((job.progress.done / job.progress.total) * 100)
          : 0;
      return { text: `${p}%`, cls: "text-foreground" };
    }
    case "done":
      return { text: "✓", cls: "text-green-500" };
    case "error":
      return { text: "✗", cls: "text-red-500" };
    case "cancelled":
      return { text: "—", cls: "text-muted-foreground" };
    default:
      return { text: "○", cls: "text-muted-foreground" };
  }
}

/** Basename of a video's filename (ImageVideo filenames are string[]). */
function baseName(filename: string | string[]): string {
  const p = Array.isArray(filename) ? filename[0] ?? "" : filename;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function rangeSummary(c: ClipConfig): string {
  const len = c.video.shape?.[0] ?? 0;
  return c.start === 0 && c.end === Math.max(0, len - 1)
    ? "full"
    : `${c.start}–${c.end}`;
}

interface ClipVideoListProps {
  configs: ClipConfig[];
  focused: Video | null;
  onFocus: (v: Video) => void;
  onToggleInclude: (v: Video) => void;
  onSetAll: (include: boolean) => void;
  /** Per-video runtime status during a batch export (empty when idle). */
  jobs?: Map<Video, ClipJobInfo>;
  /** Disable include/select-all interaction (e.g. while exporting). */
  disabled?: boolean;
}

export function ClipVideoList({
  configs,
  focused,
  onFocus,
  onToggleInclude,
  onSetAll,
  jobs,
  disabled,
}: ClipVideoListProps) {
  const nIncluded = configs.filter((c) => c.include).length;
  const allIncluded = configs.length > 0 && nIncluded === configs.length;

  return (
    <div className="flex flex-col min-h-0 h-full border border-border rounded overflow-hidden">
      <div className="flex items-center justify-between px-2 h-8 border-b border-border text-xs text-muted-foreground shrink-0">
        <span className="tabular-nums">
          {nIncluded} / {configs.length} selected
        </span>
        <button
          type="button"
          className="hover:text-foreground disabled:opacity-50"
          disabled={disabled}
          onClick={() => onSetAll(!allIncluded)}
        >
          {allIncluded ? "Deselect all" : "Select all"}
        </button>
      </div>
      <div className="overflow-auto min-h-0 flex-1">
        {configs.map((c, i) => {
          const isFocused = c.video === focused;
          const job = jobs?.get(c.video);
          const ind = job ? jobIndicator(job) : null;
          return (
            <button
              type="button"
              key={i}
              onClick={() => onFocus(c.video)}
              title={baseName(c.video.filename)}
              className={cn(
                "flex items-center gap-2 w-full px-2 h-8 text-left text-xs border-b border-border/40 last:border-b-0",
                isFocused ? "bg-accent text-foreground" : "hover:bg-accent/50"
              )}
            >
              <input
                type="checkbox"
                checked={c.include}
                disabled={disabled}
                aria-label={`Include ${baseName(c.video.filename)}`}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleInclude(c.video)}
              />
              <span className="flex-1 min-w-0 truncate">
                {baseName(c.video.filename)}
              </span>
              {ind ? (
                <span className={cn("tabular-nums shrink-0", ind.cls)}>{ind.text}</span>
              ) : (
                <span className="tabular-nums text-muted-foreground shrink-0">
                  {rangeSummary(c)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
