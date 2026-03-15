/**
 * Videos panel: lists all videos in the project.
 *
 * Shows filename (truncated from left), frame count, and resolution.
 * Click to select a video as the active video.
 * Missing videos (no backend) show a warning icon and a Locate button.
 */

import { useAppStore } from "../../stores/appStore";
import { getPlatform } from "../../platform";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Clipboard, Check } from "lucide-react";
import { useState } from "react";
import type { Video } from "../../types";
import {
  isVideoMissing,
  resolveVideoFile,
  resolveAllVideoFiles,
} from "../../lib/resolveVideos";

/** Truncate a filename/path from the left, keeping the rightmost characters. */
function truncateLeft(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return "\u2026" + path.slice(path.length - maxLen + 1);
}

/** Extract just the basename from a file path. */
function basename(path: string | string[]): string {
  const p = Array.isArray(path) ? path[0] ?? "" : path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function VideoRow({
  video,
  index,
  isSelected,
  isMissing,
  onSelect,
  onLocate,
}: {
  video: Video;
  index: number;
  isSelected: boolean;
  isMissing: boolean;
  onSelect: () => void;
  onLocate: () => void;
}) {
  const shape = video.shape;
  const frameCount = shape?.[0] ?? "?";
  const height = shape?.[1] ?? "?";
  const width = shape?.[2] ?? "?";

  return (
    <TableRow
      onClick={onSelect}
      className={cn(
        "cursor-pointer border-b-0",
        isSelected
          ? "bg-orange-500/10 border-l-2 border-l-orange-500 text-foreground"
          : "hover:bg-muted/50 text-foreground"
      )}
    >
      <TableCell className="py-0.5 px-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {isMissing && (
            <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
          )}
          {index + 1}
        </span>
      </TableCell>
      <TableCell
        className="py-0.5 px-2 text-xs"
        title={
          Array.isArray(video.filename) ? video.filename[0] : video.filename
        }
      >
        <span className="flex items-center gap-1">
          <span className={cn(isMissing && "text-muted-foreground")}>
            {truncateLeft(basename(video.filename), 30)}
          </span>
          {isMissing && (
            <Button
              variant="subtle"
              size="xs"
              className="h-4 px-1 text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                onLocate();
              }}
            >
              Locate
            </Button>
          )}
        </span>
      </TableCell>
      <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums">
        {frameCount}
      </TableCell>
      <TableCell className="py-0.5 px-2 text-xs text-right tabular-nums text-muted-foreground">
        {width}x{height}
      </TableCell>
    </TableRow>
  );
}

/** Resolve a video filename to an absolute path when possible. */
function resolveVideoPath(video: Video, projectFilename: string | null): string {
  const raw = Array.isArray(video.filename) ? video.filename[0] : video.filename;
  if (!raw) return "";
  // Already absolute (Unix or Windows)
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  // Resolve relative paths against the project file's directory
  if (projectFilename) {
    const sep = projectFilename.includes("\\") ? "\\" : "/";
    const dir = projectFilename.substring(
      0,
      projectFilename.lastIndexOf(sep)
    );
    return dir + sep + raw.replace(/[\\/]/g, sep);
  }
  return raw;
}

/** Format a duration in seconds to MM:SS or HH:MM:SS. */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function VideoDetailPanel({ video }: { video: Video }) {
  const projectFilename = useAppStore((s) => s.filename);
  const [copied, setCopied] = useState(false);

  const filePath = resolveVideoPath(video, projectFilename);
  const shape = video.shape;
  const fps = video.fps;
  const frames = shape?.[0] ?? null;
  const height = shape?.[1] ?? null;
  const width = shape?.[2] ?? null;
  const channels = shape?.[3] ?? null;
  const duration = frames != null && fps ? frames / fps : null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="p-2 text-xs space-y-1">
      {/* File path with copy button */}
      <div className="flex items-start gap-1">
        <div
          className="text-muted-foreground min-w-0 flex-1 break-all select-all"
          title={filePath}
        >
          <span className="font-medium text-foreground">File: </span>
          {filePath}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0"
          onClick={handleCopy}
          title="Copy path"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Clipboard className="h-3 w-3" />
          )}
        </Button>
      </div>

      {/* Metadata grid */}
      {shape && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
          {width != null && height != null && (
            <div>
              <span className="font-medium text-foreground">Resolution: </span>
              {width}&times;{height}
              {channels != null && <span> &times;{channels}ch</span>}
            </div>
          )}
          {fps != null && (
            <div>
              <span className="font-medium text-foreground">FPS: </span>
              {Number.isInteger(fps) ? fps : fps.toFixed(2)}
            </div>
          )}
          {frames != null && (
            <div>
              <span className="font-medium text-foreground">Frames: </span>
              {frames.toLocaleString()}
            </div>
          )}
          {duration != null && (
            <div>
              <span className="font-medium text-foreground">Duration: </span>
              {formatDuration(duration)}
            </div>
          )}
        </div>
      )}

      {/* Backend metadata */}
      {(() => {
        const meta = video.backendMetadata as Record<string, unknown>;
        const backendName =
          video.backend?.constructor?.name ??
          (typeof meta.type === "string" ? meta.type : null);
        const format = typeof meta.format === "string" ? meta.format : null;
        const dataset = typeof meta.dataset === "string" && meta.dataset !== "" ? meta.dataset : null;
        const grayscale = typeof meta.grayscale === "boolean" ? meta.grayscale : null;

        if (!backendName && !format && !dataset) return null;
        return (
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground">
            {backendName && (
              <div>
                <span className="font-medium text-foreground">Backend: </span>
                {backendName}
              </div>
            )}
            {format && (
              <div>
                <span className="font-medium text-foreground">Format: </span>
                {format}
              </div>
            )}
            {dataset && (
              <div className="col-span-2">
                <span className="font-medium text-foreground">Dataset: </span>
                {dataset}
              </div>
            )}
            {grayscale != null && (
              <div>
                <span className="font-medium text-foreground">Color: </span>
                {grayscale ? "Grayscale" : "Color"}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

async function handleAddVideos() {
  try {
    const platform = await getPlatform();
    const result = await platform.showOpenDialog({
      filters: [
        { name: "Video Files", extensions: ["mp4", "avi", "mov", "mkv", "h5", "hdf5"] },
      ],
    });

    if (!result) return; // User cancelled

    // For now, show an informational toast since adding standalone videos
    // to an existing project requires more plumbing in sleap-io.js
    toast.info("Video file selected", {
      description: "Adding standalone videos to a project is not yet fully supported. Open a .slp file that includes your videos.",
    });
  } catch (err) {
    toast.error("Failed to open file picker", {
      description: err instanceof Error ? err.message : String(err),
    });
  }
}

export function VideosPanel() {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const bumpOverlayVersion = useAppStore((s) => s.bumpOverlayVersion);

  const videos = labels?.videos ?? [];
  const missingVideos = videos.filter(isVideoMissing);

  const handleLocateVideo = async (video: Video) => {
    const ok = await resolveVideoFile(video);
    if (ok) {
      bumpOverlayVersion();
      // If this is the current video, force a frame re-load
      if (video === currentVideo) {
        setVideo(video);
        setFrameIdx(frameIdx);
      }
    }
  };

  const handleLocateAll = async () => {
    const count = await resolveAllVideoFiles(missingVideos);
    if (count > 0) {
      bumpOverlayVersion();
      // If the current video was resolved, force a frame re-load
      if (currentVideo && !isVideoMissing(currentVideo)) {
        setVideo(currentVideo);
        setFrameIdx(frameIdx);
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        {videos.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No videos in project.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b hover:bg-transparent">
                <TableHead className="py-1 px-2 text-xs font-normal h-auto">
                  #
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal h-auto">
                  Filename
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal text-right h-auto">
                  Frames
                </TableHead>
                <TableHead className="py-1 px-2 text-xs font-normal text-right h-auto">
                  Size
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {videos.map((video, i) => (
                <VideoRow
                  key={i}
                  video={video}
                  index={i}
                  isSelected={video === currentVideo}
                  isMissing={isVideoMissing(video)}
                  onSelect={() => setVideo(video)}
                  onLocate={() => handleLocateVideo(video)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </ScrollArea>

      {currentVideo && (
        <>
          <Separator />
          <VideoDetailPanel video={currentVideo} />
        </>
      )}

      <Separator />
      <div className="flex gap-1 p-2">
        <Button
          variant="subtle"
          size="xs"
          onClick={handleAddVideos}
        >
          Add Videos
        </Button>
        <Button
          variant="subtle"
          size="xs"
          onClick={() => toast.info("Remove Video is not yet implemented")}
        >
          Remove Video
        </Button>
        {missingVideos.length > 0 && (
          <Button
            variant="subtle"
            size="xs"
            onClick={handleLocateAll}
          >
            Locate All Missing
          </Button>
        )}
      </div>
    </div>
  );
}
