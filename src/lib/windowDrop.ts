/**
 * Whole-window drag-and-drop routing for a LOADED project. When a file is dropped
 * anywhere on the window (not onto an element-scoped dropzone), classify it and
 * prompt:
 *   - a supported video → "Add to project?" (goes through the normal add flow,
 *     which auto-transcodes legacy codecs on desktop),
 *   - an `.slp` → handled by {@link import("./slpDrop").routeSlpDrop} (Merge / open
 *     in a new window / cancel — see that module),
 *   - anything else → a clear "unsupported file" toast.
 *
 * The catcher overlay + drag-active state live in AppShell/appStore; App.tsx wires
 * the Tauri (`onDragDropEvent`) and browser (`drop`) events to these routers.
 */

import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";
import { ellipsizeMiddle } from "@/lib/ellipsize";
import { choiceDialog } from "@/stores/choiceStore";
import {
  addVideoFileToLabels,
  pickedFromFiles,
  pickedFromPaths,
  SUPPORTED_VIDEO_EXTS,
  type PickedVideoFile,
} from "@/lib/resolveVideos";

/** Last path segment (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const supportedList = () => SUPPORTED_VIDEO_EXTS.map((e) => e.toUpperCase()).join(", ");

/**
 * Add picked videos to the current project — mirrors VideosPanel.handleConfirmImport
 * (add each → reindex once → mark changed → refresh overlay → select the first).
 * The desktop transcode prompt/progress for legacy codecs is inherited via
 * `addVideoFileToLabels` → `createBackendForPath`.
 */
export async function addVideosToProject(picked: PickedVideoFile[]): Promise<number> {
  const st = useAppStore.getState();
  const labels = st.labels;
  if (!labels) return 0;
  const added = [];
  for (const pv of picked) {
    const video = await addVideoFileToLabels(labels, pv);
    if (video) added.push(video);
  }
  if (added.length > 0) {
    labels.reindex();
    st.markChanged();
    st.bumpOverlayVersion();
    st.setVideo(added[0]);
    st.setFrameIdx(0);
  }
  return added.length;
}

async function promptAddVideos(videos: PickedVideoFile[]): Promise<void> {
  const first = videos[0];
  const name = ellipsizeMiddle(basename(first.absPath ?? first.file.name));
  const label = videos.length > 1 ? `these ${videos.length} videos` : `"${name}"`;
  const choice = await choiceDialog({
    title: "Add video to project?",
    message: `Add ${label} to the current project?`,
    // "Open in a new window" for a video isn't wired yet (no route to seed a new
    // project with a video) — Add / Cancel for now.
    options: [{ key: "add", label: "Add to project", primary: true }],
  });
  if (choice === "add") {
    const n = await addVideosToProject(videos);
    if (n > 0) toast.success(`Added ${n} video${n > 1 ? "s" : ""}`);
  }
}

function rejectUnsupported(names: string[]): void {
  const shown = names.map((n) => ellipsizeMiddle(basename(n))).join(", ");
  toast(`Can't add ${shown} — drop a video (${supportedList()}) or a .slp file.`);
}

/** Desktop: route file PATHS dropped onto the window (from Tauri `onDragDropEvent`). */
export async function routeDroppedPaths(paths: string[]): Promise<void> {
  const slp = paths.find((p) => p.toLowerCase().endsWith(".slp"));
  if (slp) {
    const { routeSlpDrop } = await import("./slpDrop");
    await routeSlpDrop(slp);
    return;
  }
  // Non-.slp drops only act on a loaded project; otherwise the Welcome / New
  // Project dropzones own the empty-window case.
  if (!useAppStore.getState().projectLoaded) return;
  const videos = pickedFromPaths(paths);
  if (videos.length) return promptAddVideos(videos);
  rejectUnsupported(paths);
}

/** Browser: route dropped `File`s (video-add only; `.slp` is handled in App.tsx). */
export async function routeDroppedFiles(files: File[]): Promise<void> {
  if (!useAppStore.getState().projectLoaded) return;
  const videos = pickedFromFiles(files);
  if (videos.length) return promptAddVideos(videos);
  rejectUnsupported(files.map((f) => f.name));
}
