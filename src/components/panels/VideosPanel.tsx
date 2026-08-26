/**
 * Videos panel: lists all videos in the project.
 *
 * Shows filename (truncated from left), frame count, and resolution.
 * Click to select a video as the active video.
 * Missing videos (no backend) show a warning icon and a Locate button.
 */

import { useAppStore } from "../../stores/appStore";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { VideoDropzone } from "@/components/common/VideoDropzone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Clipboard, Check, Search, X } from "lucide-react";
import { useState } from "react";
import type { Video } from "../../types";
import { videoBasename, videoFilenameMatches } from "@/lib/videoFilter";
import {
  isVideoMissing,
  isImageSequenceVideo,
  resolveImageSequenceVideo,
  resolveVideoFile,
  resolveAllVideosFromFolder,
  resolveVideoPath,
  pickVideoFiles,
  buildStandaloneVideo,
  addVideoFileToLabels,
} from "../../lib/resolveVideos";
import {
  VideoImportList,
  toVideoImportEntries,
  type VideoImportEntry,
} from "@/components/dialogs/VideoImportList";
import { displayFrameCount } from "@/lib/videoFrameCount";
import { getPlatform, isTauri } from "../../platform/index";
import {
  labeledFramesBeyond,
  applyVideoReplacement,
} from "../../lib/replaceVideo";
import { nextSelectedVideo } from "../../lib/removeVideo";

/** Truncate a filename/path from the left, keeping the rightmost characters. */
function truncateLeft(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return "\u2026" + path.slice(path.length - maxLen + 1);
}

function VideoRow({
  video,
  index,
  isSelected,
  isMissing,
  isImageSequence,
  canLocateFolder,
  onSelect,
  onLocate,
  onLocateFolder,
}: {
  video: Video;
  index: number;
  isSelected: boolean;
  isMissing: boolean;
  isImageSequence: boolean;
  canLocateFolder: boolean;
  onSelect: () => void;
  onLocate: () => void;
  onLocateFolder: () => void;
}) {
  const shape = video.shape;
  // Embedded image count for a pkg.slp video (matches PyQt), else source frames.
  const frameCount = displayFrameCount(video) ?? "?";
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
            {truncateLeft(videoBasename(video.filename), 30)}
          </span>
          {isMissing &&
            (isImageSequence ? (
              canLocateFolder ? (
                <Button
                  variant="subtle"
                  size="xs"
                  className="h-4 px-1 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocateFolder();
                  }}
                >
                  Locate folder…
                </Button>
              ) : (
                <span className="text-[10px] italic text-muted-foreground">
                  image sequence — open in desktop app
                </span>
              )
            ) : (
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
            ))}
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

/** Format a duration in seconds to MM:SS or HH:MM:SS. */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function VideoDetailPanel({ video }: { video: Video }) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [copied, setCopied] = useState(false);

  const resolvedPath = resolveVideoPath(video, projectPath);
  const shape = video.shape;
  const fps = video.fps;
  // Embedded image count for a pkg.slp video (matches PyQt), else source frames.
  const frames = displayFrameCount(video);
  const height = shape?.[1] ?? null;
  const width = shape?.[2] ?? null;
  const channels = shape?.[3] ?? null;
  const duration = frames != null && fps ? frames / fps : null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(resolvedPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const meta = video.backendMetadata as Record<string, unknown>;
  const backendName =
    video.backend?.constructor?.name ??
    (typeof meta.type === "string" ? meta.type : null);
  const format = typeof meta.format === "string" ? meta.format : null;
  const dataset =
    typeof meta.dataset === "string" && meta.dataset !== ""
      ? meta.dataset
      : null;
  const grayscale =
    typeof meta.grayscale === "boolean" ? meta.grayscale : null;
  const sourceFilename =
    typeof meta.sourceFilename === "string" ? meta.sourceFilename : null;
  const hasMetadata = !!(backendName || format || dataset || sourceFilename);

  return (
    <div className="p-2 text-xs space-y-1">
      {/* File path with copy button */}
      <div className="flex items-start gap-1">
        <div
          className="text-muted-foreground min-w-0 flex-1 break-all select-all"
          title={resolvedPath}
        >
          <span className="font-medium text-foreground">File: </span>
          {resolvedPath}
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

      {/* Video stats */}
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

      {/* Collapsible SLP metadata */}
      {hasMetadata && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none font-medium">
            Metadata
          </summary>
          <div className="mt-1 space-y-0.5 text-muted-foreground">
            {sourceFilename && (
              <div className="break-all">
                <span className="font-medium text-foreground">
                  Source path:{" "}
                </span>
                {sourceFilename}
              </div>
            )}
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
              <div className="break-all">
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
        </details>
      )}
    </div>
  );
}

export function VideosPanel() {
  const labels = useAppStore((s) => s.labels);
  const currentVideo = useAppStore((s) => s.video);
  const setVideo = useAppStore((s) => s.setVideo);
  const setFrameIdx = useAppStore((s) => s.setFrameIdx);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const bumpOverlayVersion = useAppStore((s) => s.bumpOverlayVersion);
  const markVideoUpdated = useAppStore((s) => s.markVideoUpdated);
  const markChanged = useAppStore((s) => s.markChanged);

  // Filename search: case-insensitive substring match on each video's basename.
  // Preserves each video's original index (for the # column + stable keys) so
  // filtering never renumbers the list or breaks identity-based selection.
  const [search, setSearch] = useState("");

  const videos = labels?.videos ?? [];
  const filteredVideos = videos
    .map((video, index) => ({ video, index }))
    .filter(({ video }) => videoFilenameMatches(video.filename, search));
  const missingVideos = videos.filter(isVideoMissing);
  // "Locate All Missing" only handles regular videos: its multi-file video
  // picker can't select images, so image sequences are located per-row via
  // their own folder pick (the Locate-folder dialog / applyImageFolder).
  const missingResolvable = missingVideos.filter((v) => !isImageSequenceVideo(v));

  // Image-sequence Locate-folder dialog: the video awaiting a folder, plus the
  // path field (populated by Browse… or pasted directly). null = closed.
  // `resolving` guards the (slow, per-frame) resolve against re-entrant submits.
  const [locateFolder, setLocateFolder] = useState<Video | null>(null);
  const [folderPathInput, setFolderPathInput] = useState("");
  const [resolving, setResolving] = useState(false);

  // Pending confirm-trim state for Replace Video: set when the chosen
  // replacement is shorter than the current video's labeled frames, so some
  // frames would be orphaned. null = no dialog open.
  const [pendingReplace, setPendingReplace] = useState<{
    oldVideo: Video;
    newVideo: Video;
    orphanCount: number;
    newCount: number;
  } | null>(null);

  // Pending confirm state for Remove Video: set when the target video has
  // labeled frames (which would be deleted). null = no dialog open.
  const [pendingRemove, setPendingRemove] = useState<{
    video: Video;
    frameCount: number;
  } | null>(null);

  // Staged videos from the "Add Videos" picker, awaiting the Import Videos
  // dialog's grayscale choice + confirmation. null = no dialog open. Mirrors
  // NewProjectDialog's staged list, but as a standalone confirm step here
  // since this panel adds directly (no larger dialog already open to stage in).
  const [pendingImport, setPendingImport] = useState<VideoImportEntry[] | null>(
    null
  );
  const [importing, setImporting] = useState(false);

  const handleLocateVideo = async (video: Video) => {
    const ok = await resolveVideoFile(video, labels ?? undefined);
    if (ok) {
      bumpOverlayVersion();
      // The backend just set video.shape[0] to the true source frame count
      // (in place, same object). Bump videoRevision so the seekbar's
      // shape-keyed memo re-reads it and re-extends the timeline to the full
      // video (otherwise it stays clamped to the last labeled frame).
      markVideoUpdated();
      // If this is the current video, force a frame re-load
      if (video === currentVideo) {
        setVideo(video);
        setFrameIdx(frameIdx);
      }
    }
  };

  // Apply a picked/typed folder to the pending image-sequence video. The folder
  // may be any ancestor of the images (resolveImageSequenceVideo detects the
  // subfolder depth), so the user never has to open the leaf image directory —
  // which on a network mount with 10k+ files can freeze the native dialog.
  const applyImageFolder = async (video: Video, folder: string) => {
    if (resolving) return; // ignore re-entrant submits (double-click / Enter)
    setResolving(true);
    try {
      const platform = await getPlatform();
      const ok = await resolveImageSequenceVideo(
        video,
        folder.trim(),
        platform.exists
      );
      if (ok) {
        setLocateFolder(null);
        bumpOverlayVersion();
        markVideoUpdated(); // re-read the now-known shape → re-extend the seekbar
        // If this is the current video, force a frame re-load
        if (video === currentVideo) {
          setVideo(video);
          setFrameIdx(frameIdx);
        }
      }
    } finally {
      setResolving(false);
    }
  };

  // Native folder picker used from inside the Locate-folder dialog. Fills the
  // path field so the user can review/edit before confirming.
  const handleBrowseImageFolder = async () => {
    const platform = await getPlatform();
    const folder = await platform.showOpenDialog({ directory: true });
    if (folder && typeof folder === "string") setFolderPathInput(folder);
  };

  const handleLocateAll = async () => {
    // Pick ONE folder and match all missing videos by basename (browser,
    // Chromium); falls back to a multi-file picker where showDirectoryPicker is
    // unavailable or on Tauri. Explicit action — never auto-run on project load.
    const count = await resolveAllVideosFromFolder(missingResolvable);
    if (count > 0) {
      bumpOverlayVersion();
      markVideoUpdated(); // re-read now-known shapes → re-extend the seekbar
      // If the current video was resolved, force a frame re-load
      if (currentVideo && !isVideoMissing(currentVideo)) {
        setVideo(currentVideo);
        setFrameIdx(frameIdx);
      }
    }
  };

  /** Add every staged video from the Import Videos dialog, with its chosen grayscale flag. */
  const handleConfirmImport = async () => {
    if (!labels || !pendingImport) return;
    setImporting(true);
    try {
      const added: Video[] = [];
      for (const pv of pendingImport) {
        const video = await addVideoFileToLabels(labels, pv, pv.grayscale);
        if (video) added.push(video);
      }
      if (added.length > 0) labels.reindex();
      setPendingImport(null);
      if (added.length === 0) return; // unsupported/failed (already toasted)
      markChanged();
      bumpOverlayVersion();
      // Select the first newly-added video and load its first frame.
      setVideo(added[0]);
      setFrameIdx(0);
      toast.success(`Added ${added.length} video${added.length > 1 ? "s" : ""}`);
    } finally {
      setImporting(false);
    }
  };

  /**
   * Re-point the current project from `oldVideo` to `newVideo` (trimming any
   * labeled frames beyond the new video's length), select the new video, clamp
   * the playhead, and refresh the UI. Called directly when nothing is trimmed,
   * or from the confirm dialog's Replace button when frames would be removed.
   */
  const commitReplace = (oldVideo: Video, newVideo: Video) => {
    if (!labels) return;
    const { trimmed } = applyVideoReplacement(labels, oldVideo, newVideo);
    setVideo(newVideo);
    setFrameIdx(Math.min(frameIdx, (newVideo.shape?.[0] ?? 1) - 1));
    markChanged();
    bumpOverlayVersion();
    setPendingReplace(null);
    toast.success(
      trimmed > 0
        ? `Replaced video — ${trimmed} labeled frame${trimmed > 1 ? "s" : ""} removed`
        : "Replaced video"
    );
  };

  /**
   * Pick a new video file, build a fresh (decoded) backend for it, and replace
   * the currently-selected video with it. If labeled frames would be orphaned
   * (the new video is shorter), open a confirm-trim dialog first; otherwise
   * apply the replacement immediately.
   */
  const handleReplaceVideo = async () => {
    if (!labels || !currentVideo) return;
    let files;
    try {
      files = await pickVideoFiles();
    } catch (err) {
      toast.error("Failed to replace video", {
        description: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (files.length === 0) return; // cancelled
    const newVideo = await buildStandaloneVideo(files[0].file, files[0].absPath);
    if (!newVideo) return; // unsupported / decode failed (already toasted)

    const newCount = newVideo.shape?.[0] ?? Infinity;
    const orphans = labeledFramesBeyond(labels, currentVideo, newCount);
    if (orphans.length > 0) {
      setPendingReplace({
        oldVideo: currentVideo,
        newVideo,
        orphanCount: orphans.length,
        newCount,
      });
      return; // dialog's Replace button calls commitReplace
    }
    commitReplace(currentVideo, newVideo);
  };

  /**
   * Remove `video` and every reference to it (labeled frames + their ROIs,
   * suggestions, static ROIs) via `Labels.removeVideo`, then reselect a
   * neighbouring video — or clear the selection if none remain — and refresh.
   * Called directly when the video has no labels, or from the confirm dialog.
   */
  const commitRemove = (video: Video) => {
    if (!labels) return;
    const wasCurrent = video === currentVideo;
    const next = nextSelectedVideo(labels.videos, video);
    labels.removeVideo(video);
    if (wasCurrent) {
      // The store's `video` state is nullable; the typed `setVideo` action
      // narrows to Video, so cast when clearing after the last video is gone.
      setVideo(next as Video);
    }
    markChanged();
    bumpOverlayVersion();
    setPendingRemove(null);
    toast.success("Removed video");
  };

  /**
   * Remove the selected video. If it has labeled frames, confirm first (they
   * will be deleted); otherwise remove immediately.
   */
  const handleRemoveVideo = () => {
    if (!labels || !currentVideo) return;
    const frameCount = labels.find({ video: currentVideo }).length;
    if (frameCount > 0) {
      setPendingRemove({ video: currentVideo, frameCount });
      return; // dialog's Remove button calls commitRemove
    }
    commitRemove(currentVideo);
  };

  return (
    <div className="flex flex-col h-full">
      {videos.length > 0 && (
        <div className="p-2 pb-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-7 text-xs pl-7 pr-7"
              placeholder="Search videos…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
                onClick={() => setSearch("")}
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0">
        {videos.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No videos in project.
          </p>
        ) : filteredVideos.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            No videos match “{search}”.
          </p>
        ) : (
          <Table className="w-max min-w-full">
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
              {filteredVideos.map(({ video, index }) => (
                <VideoRow
                  key={index}
                  video={video}
                  index={index}
                  isSelected={video === currentVideo}
                  isMissing={isVideoMissing(video)}
                  isImageSequence={isImageSequenceVideo(video)}
                  canLocateFolder={isTauri}
                  onSelect={() => setVideo(video)}
                  onLocate={() => handleLocateVideo(video)}
                  onLocateFolder={() => {
                    setFolderPathInput("");
                    setResolving(false);
                    setLocateFolder(video);
                  }}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {currentVideo && (
        <>
          <Separator />
          <VideoDetailPanel video={currentVideo} />
        </>
      )}

      <Separator />
      <div className="px-2 pt-2">
        <VideoDropzone
          onFiles={(picked) => setPendingImport(toVideoImportEntries(picked))}
          data-tutorial="add-videos-button"
        />
      </div>
      <div className="flex gap-1 p-2">
        <Button
          variant="subtle"
          size="xs"
          disabled={!currentVideo}
          onClick={handleReplaceVideo}
        >
          Replace Video
        </Button>
        <Button
          variant="subtle"
          size="xs"
          disabled={!currentVideo}
          onClick={handleRemoveVideo}
        >
          Remove Video
        </Button>
        {missingResolvable.length > 0 && (
          <Button
            variant="subtle"
            size="xs"
            onClick={handleLocateAll}
          >
            Locate All Missing
          </Button>
        )}
      </div>

      {/* Import Videos dialog: confirm the picked file(s) and choose grayscale
          per-file/bulk before actually adding them (legacy Qt GUI parity). */}
      <Dialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open && !importing) setPendingImport(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Import Videos</DialogTitle>
            <DialogDescription>
              Choose which video(s) to import as grayscale. This can&apos;t be
              changed after import.
            </DialogDescription>
          </DialogHeader>
          {pendingImport && (
            <VideoImportList
              videos={pendingImport}
              onChange={setPendingImport}
              onRemove={(i) =>
                setPendingImport((v) => v?.filter((_, idx) => idx !== i) ?? null)
              }
              disabled={importing}
            />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingImport(null)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmImport}
              disabled={importing || !pendingImport?.length}
            >
              {importing ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace Video confirm-trim dialog */}
      <Dialog
        open={pendingReplace !== null}
        onOpenChange={(open) => {
          if (!open) setPendingReplace(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Replace video?</DialogTitle>
            <DialogDescription>
              {pendingReplace && (
                <>
                  The new video has {pendingReplace.newCount} frames;{" "}
                  {pendingReplace.orphanCount} labeled frame
                  {pendingReplace.orphanCount > 1 ? "s" : ""} beyond that will be
                  removed. This can&apos;t be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingReplace(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingReplace) {
                  commitReplace(
                    pendingReplace.oldVideo,
                    pendingReplace.newVideo
                  );
                }
              }}
            >
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Video confirm dialog (shown only when the video has labels) */}
      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove video?</DialogTitle>
            <DialogDescription>
              {pendingRemove && (
                <>
                  {pendingRemove.frameCount} labeled frame
                  {pendingRemove.frameCount > 1 ? "s" : ""} on this video will be
                  deleted. This can&apos;t be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingRemove(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingRemove) commitRemove(pendingRemove.video);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Locate image folder dialog (image sequences): Browse… or paste a path */}
      <Dialog
        open={locateFolder !== null}
        onOpenChange={(open) => {
          if (!open) setLocateFolder(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Locate image folder</DialogTitle>
            <DialogDescription>
              Choose the folder that contains this sequence&apos;s images — or any
              parent of it. Paste a path to avoid opening large folders on slow
              network drives.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-1">
            <Input
              autoFocus
              className="h-8 text-xs font-mono"
              placeholder="Folder path…"
              value={folderPathInput}
              disabled={resolving}
              onChange={(e) => setFolderPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !resolving &&
                  folderPathInput.trim() &&
                  locateFolder
                ) {
                  applyImageFolder(locateFolder, folderPathInput);
                }
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              disabled={resolving}
              onClick={handleBrowseImageFolder}
            >
              Browse…
            </Button>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={resolving}
              onClick={() => setLocateFolder(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!folderPathInput.trim() || resolving}
              onClick={() => {
                if (locateFolder && folderPathInput.trim()) {
                  applyImageFolder(locateFolder, folderPathInput);
                }
              }}
            >
              {resolving ? "Locating…" : "Locate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
