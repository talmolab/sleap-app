/**
 * The menu actions too long to sit inline in `buildAppMenu`. Each reads
 * fresh store state when it runs.
 */

import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { sleapCmd } from "@/lib/sleapPlugin";

export async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}

/** Nudge the manual UI scale (View › Text Size). */
export function adjustUiScale(delta: number) {
  const s = useAppStore.getState();
  const newScale = Math.max(0.75, Math.min(1.5, s.uiScale + delta));
  s.set("uiScale", Math.round(newScale * 100) / 100);
  document.documentElement.style.setProperty("--ui-scale", String(newScale));
}

export function resetUiScale() {
  useAppStore.getState().set("uiScale", 1);
  document.documentElement.style.setProperty("--ui-scale", "1");
}

export async function replaceVideo(videoIdx: number) {
  const { labels } = useAppStore.getState();
  const v = labels?.videos[videoIdx];
  if (!v) return;
  const { resolveVideoFile } = await import("@/lib/resolveVideos");
  const ok = await resolveVideoFile(v, labels ?? undefined);
  useAppStore.getState().bumpOverlayVersion();
  // Re-read the now-known shape so the seekbar/status bar re-extend the
  // timeline to the full video (videoRevision is the memo dep; a bare
  // in-place shape set won't trigger).
  if (ok) useAppStore.getState().markVideoUpdated();
}

export async function revealProjectInFileManager() {
  const { projectPath } = useAppStore.getState();
  if (!projectPath) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke(sleapCmd("reveal_in_file_manager"), { path: projectPath });
  } catch (e) {
    const { toast } = await import("@/lib/notify");
    toast.error("Failed to reveal project file", {
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function openPreferencesDirectory() {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke(sleapCmd("open_preferences_directory"));
  } catch (e) {
    const { toast } = await import("@/lib/notify");
    toast.error("Failed to open preferences directory", {
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function clearVideoTranscodeCache() {
  const { toast } = await import("@/lib/notify");
  const {
    videoTranscodeCacheInfo,
    clearVideoTranscodeCache: clearCache,
    backendKindForFilename,
    getBasename,
  } = await import("@/lib/resolveVideos");
  const { isTranscodeCached } = await import("@/lib/transcode/transcodeVideo");
  const { createTauriTranscodeDeps } = await import(
    "@/lib/transcode/transcodeDepsTauri"
  );
  const mb = (b: number) => (b / 1_000_000).toFixed(1);
  try {
    const info = await videoTranscodeCacheInfo();
    if (info.count === 0) {
      toast.info("No transcoded videos to clear");
      return;
    }
    const plural = info.count > 1 ? "s" : "";
    // Legacy-container videos currently OPEN whose transcode is in the
    // cache — clearing now breaks their view until Replace Video / reopen.
    // (H.264/MJPEG AVIs decode directly → no cache entry → not flagged.)
    // Checks the cache file, not the backend class name, so it stays correct
    // in a minified build.
    const deps = createTauriTranscodeDeps();
    const inUse: string[] = [];
    for (const v of useAppStore.getState().labels?.videos ?? []) {
      const name = Array.isArray(v.filename) ? v.filename[0] ?? "" : v.filename;
      if (!v.backend || backendKindForFilename(name) !== "avi") continue;
      try {
        if (await isTranscodeCached(name, deps)) inUse.push(getBasename(name));
      } catch {
        /* stat failed — skip */
      }
    }
    const inUseWarning =
      inUse.length > 0
        ? `⚠ ${inUse.length} open video${inUse.length > 1 ? "s" : ""} ` +
          `(${inUse.join(", ")}) ${inUse.length > 1 ? "are" : "is"} using a converted copy right now. ` +
          `Clearing will make ${inUse.length > 1 ? "them" : "it"} show ` +
          "“frame image not found” until you re-convert via Replace Video " +
          "(or reopen the project).\n\n"
        : "";
    // In-app styled confirm — NOT window.confirm or a native OS dialog
    // (both broken/inconsistent in the Tauri WebView); this matches the
    // app's look and works in browser + desktop.
    const { confirmDialog } = await import("@/stores/confirmStore");
    const proceed = await confirmDialog({
      title: "Clear video transcode cache",
      message:
        inUseWarning +
        `Clear ${info.count} transcoded video${plural} (${mb(info.bytes)} MB)?\n\n` +
        "These legacy-format conversions are re-created automatically " +
        "the next time you open the original files.",
      confirmLabel: "Clear",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!proceed) return;
    const freed = await clearCache();
    toast.success(
      `Cleared ${freed.count} transcoded video${freed.count > 1 ? "s" : ""} (${mb(freed.bytes)} MB)`
    );
  } catch (e) {
    toast.error("Failed to clear transcode cache", {
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function quit() {
  const { quitApp } = await import("@/lib/quit");
  await quitApp();
}

export function cycleVideo(step: 1 | -1) {
  const { labels, video, setVideo } = useAppStore.getState();
  if (!labels || !video) return;
  const n = labels.videos.length;
  const idx = labels.videos.indexOf(video);
  const next = labels.videos[(idx + step + n) % n];
  if (next) setVideo(next);
}

export function selectNextInstance() {
  const { labeledFrame, instance, setInstance } = useAppStore.getState();
  if (!labeledFrame) return;
  const instances = labeledFrame.instances;
  if (instances.length === 0) return;
  if (!instance) {
    setInstance(instances[0]);
  } else {
    const idx = instances.indexOf(instance);
    setInstance(instances[(idx + 1) % instances.length]);
  }
}

export function markFrame() {
  const s = useAppStore.getState();
  if (s.video) s.setMarkedFrame({ video: s.video, frameIdx: s.frameIdx });
}

export function togglePlacementMode() {
  const s = useAppStore.getState();
  if (s.labelingMode === "place") {
    s.exitPlacementMode();
  } else if (s.instance) {
    s.enterPlacementMode();
  }
}
