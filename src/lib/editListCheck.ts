/**
 * Open-time (and relink-time) check for labels made before frames were
 * numbered like ffmpeg (sleap-io.js #274). See `editListShift.ts` for which
 * labels that concerns and how each video's answer is recorded.
 *
 * For an opened `.slp` (or restored draft):
 *  1. `expectEditListCheck(labels)` before `setLabels` remembers which videos
 *     came from the file — only their labels can be in the old numbering.
 *  2. `runEditListCheck(labels)` after it is installed: for each MP4/MOV video
 *     with no record yet, learn its hidden-frame count (from its backend, or,
 *     for a video desktop hasn't opened yet, from a temporary backend that is
 *     closed right away), then:
 *     - io can't tell (sleap-io.js < 0.5.18) → nothing recorded or asked: labels
 *       made meanwhile are in the old numbering too, so a later check is right;
 *     - no hidden frames → nothing to do;
 *     - hidden frames, but no labels from the file → record "ffmpeg";
 *     - hidden frames and labels from the file → ask: Keep as is (the default)
 *       or Shift N frames earlier. Closing the message keeps them. Either answer
 *       is recorded for that video alone, so it is never asked again.
 *  3. A video whose file was missing gets checked as soon as it's located
 *     (re-run on backend changes and edits). It can't be labeled while
 *     missing, so everything on it is still from the file.
 *
 * Videos added in this session, and every video of a new project or an import,
 * are numbered by this version (or an ffmpeg-based tool): recorded "ffmpeg".
 */

import { useAppStore } from "@/stores/appStore";
import { choiceDialog, type ChoiceRequest } from "@/stores/choiceStore";
import { commandContext } from "@/commands/CommandContext";
import { ShiftVideoLabelsCommand } from "@/commands/editListCommands";
import type { VideoBackend } from "@talmolab/sleap-io.js";
import type { Labels, Video } from "../types";
import {
  canHaveEditList,
  getVideoRecord,
  hasShiftableContent,
  hiddenLeadingFramesOfBackend,
  planLabelShift,
  setVideoRecord,
  supportsHiddenFrameDetection,
  videoName,
  type LabelShiftPlan,
} from "./editListShift";
import { createPlainBackendForPath } from "./resolveVideos";

/** What is known about a video's hidden frames. */
export type HiddenFrameDetection = { supported: false } | { supported: true; hidden: number };

/** Read detection off a backend. */
export function detectFromBackend(backend: VideoBackend | null | undefined): HiddenFrameDetection | null {
  if (!backend) return null;
  return supportsHiddenFrameDetection(backend)
    ? { supported: true, hidden: hiddenLeadingFramesOfBackend(backend) }
    : { supported: false };
}

/** Videos that came from the opened file, per project. */
const videosFromFile = new WeakMap<Labels, WeakSet<Video>>();

/** Remember which videos an opened `.slp` brought; call BEFORE `setLabels`. */
export function expectEditListCheck(labels: Labels): void {
  videosFromFile.set(labels, new WeakSet(labels.videos));
}

/** Choice keys returned by the prompt. */
export const SHIFT_CHOICE = "shift";
export const KEEP_CHOICE = "keep";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A video the check asks about. */
export interface EditListCandidate {
  video: Video;
  hidden: number;
  plan: LabelShiftPlan;
}

/** The prompt for one video (plain language; exported for tests). */
export function buildShiftPrompt(c: EditListCandidate): ChoiceRequest {
  const n = c.hidden;
  const frames = plural(n, "frame");
  const { plan } = c;
  const them = n === 1 ? "it" : "them";
  const lines: string[] = [
    `This video starts with ${plural(n, "hidden frame")}: ${n === 1 ? "a frame" : "frames"} the file keeps only so the next frames can be decoded (common after cutting a video with ffmpeg's stream copy). ffmpeg and SLEAP (Python) skip ${them}, and this version of the app now does too. Earlier versions of this app counted ${them}.`,
    "",
    `Labels made in an earlier version of this app now sit ${frames} after the picture they were made on. Labels made in SLEAP (Python) or another tool are already right: keep those.`,
    "",
    `Shifting moves these ${frames} earlier:`,
  ];
  if (plan.movedFrames > 0) {
    lines.push(
      `• ${plural(plan.movedFrames, "labeled frame")}: instances drawn or accepted in this app, boxes, masks and negative-frame marks`
    );
  }
  if (plan.movedSuggestions > 0) lines.push(`• ${plural(plan.movedSuggestions, "suggestion")}`);
  const dropped: string[] = [];
  if (plan.droppedFrames > 0) dropped.push(plural(plan.droppedFrames, "labeled frame"));
  if (plan.droppedSuggestions > 0) dropped.push(plural(plan.droppedSuggestions, "suggestion"));
  if (dropped.length > 0) {
    lines.push(
      `• Removed: ${dropped.join(" and ")} on the hidden ${n === 1 ? "frame" : "frames"} (nothing is shown there)`
    );
  }
  const kept: string[] = [];
  if (plan.framesWithPredictionsKept > 0) kept.push("predictions (made by SLEAP or sleap-nn, already right)");
  if (plan.linkedInstancesKept > 0) {
    kept.push(
      `${plural(plan.linkedInstancesKept, "instance")} linked to a prediction on ${plan.linkedInstancesKept === 1 ? "its" : "their"} frame (made in SLEAP)`
    );
  }
  if (kept.length > 0) lines.push(`Stays where it is: ${kept.join(", and ")}.`);
  lines.push(
    "",
    "Shifting can be undone with Edit → Undo. Closing this message keeps the labels as they are. Either way you won't be asked about this video again."
  );
  return {
    title: `Frame numbers changed for “${videoName(c.video)}”`,
    message: lines.join("\n"),
    options: [
      { key: SHIFT_CHOICE, label: `Shift ${frames} earlier` },
      { key: KEEP_CHOICE, label: "Keep as is", primary: true },
    ],
    hideCancel: true,
  };
}

/** Injected seams (tests). */
export interface EditListCheckDeps {
  /**
   * Hidden-frame detection for a video with no backend yet (desktop opens each
   * video on first view): open a temporary backend, read it, close it. Null if
   * the video can't be opened (missing file).
   */
  probe: (video: Video) => Promise<HiddenFrameDetection | null>;
  /** Ask the user; resolves a choice key, or null if the message was closed. */
  choose: (req: ChoiceRequest) => Promise<string | null>;
  /** Run the undoable shift (it records "shifted"). */
  shift: (video: Video, by: number) => Promise<void>;
  /** Record "Keep as is" and mark the project changed so the answer is saved. */
  keep: (labels: Labels, video: Video) => void;
  /** The project currently open (the check stops if it changes). */
  currentLabels: () => Labels | null;
}

/** Open a temporary backend on a desktop video deferred until first view; never kept. */
async function probeDeferredVideo(video: Video): Promise<HiddenFrameDetection | null> {
  const lazyPath = (video.backendMetadata as Record<string, unknown> | undefined)?.lazyPath;
  if (typeof lazyPath !== "string") return null;
  let backend: VideoBackend | null = null;
  try {
    backend = await createPlainBackendForPath(lazyPath);
    await backend.getFrameTimes?.(); // Mp4Box parses asynchronously; this waits for it
    return detectFromBackend(backend);
  } catch {
    return null;
  } finally {
    backend?.close();
  }
}

const defaultDeps: EditListCheckDeps = {
  probe: probeDeferredVideo,
  choose: choiceDialog,
  shift: (video, by) => commandContext.execute(ShiftVideoLabelsCommand, { video, by }),
  keep: (labels, video) => {
    setVideoRecord(labels, video, "kept");
    useAppStore.getState().markChanged();
  },
  currentLabels: () => useAppStore.getState().labels,
};

/** Detection from probing a deferred video, kept so a re-check doesn't open it again. */
const probed = new WeakMap<Video, HiddenFrameDetection>();
/** Checks in progress, and checks requested meanwhile (coalesced into one more pass). */
const running = new WeakSet<Labels>();
const rerunRequested = new WeakSet<Labels>();

/**
 * Run the check (see the module doc). `probe` (default true) opens temporary
 * backends for deferred videos; re-checks after the open skip it. Never throws.
 */
export async function runEditListCheck(
  labels: Labels,
  deps: EditListCheckDeps = defaultDeps,
  options: { probe?: boolean } = {}
): Promise<void> {
  if (running.has(labels)) {
    rerunRequested.add(labels);
    return;
  }
  running.add(labels);
  try {
    let probe = options.probe ?? true;
    do {
      rerunRequested.delete(labels);
      await checkOnce(labels, deps, probe);
      probe = false;
    } while (rerunRequested.has(labels) && deps.currentLabels() === labels);
  } catch (err) {
    console.warn("[edit-list] check failed:", err);
  } finally {
    running.delete(labels);
  }
}

async function checkOnce(labels: Labels, deps: EditListCheckDeps, probe: boolean): Promise<void> {
  const fromFile = videosFromFile.get(labels);
  const stillOpen = () => deps.currentLabels() === labels;
  for (const video of [...labels.videos]) {
    if (!stillOpen()) return;
    if (!canHaveEditList(video) || getVideoRecord(labels, video)) continue;
    const isFromFile = fromFile?.has(video) ?? false;

    let detection = detectFromBackend(video.backend) ?? probed.get(video) ?? null;
    if (!detection && probe && isFromFile && hasShiftableContent(labels, video)) {
      detection = await deps.probe(video);
      if (detection) probed.set(video, detection);
      if (!stillOpen()) return;
    }
    // Unknown (missing file) or an io that can't tell: record nothing.
    if (!detection || !detection.supported || detection.hidden === 0) continue;

    if (!isFromFile || !hasShiftableContent(labels, video)) {
      setVideoRecord(labels, video, "ffmpeg");
      continue;
    }

    const plan = planLabelShift(labels, video, detection.hidden);
    const choice = await deps.choose(buildShiftPrompt({ video, hidden: detection.hidden, plan }));
    if (!stillOpen() || getVideoRecord(labels, video)) continue;
    if (choice === SHIFT_CHOICE) await deps.shift(video, detection.hidden);
    else deps.keep(labels, video); // "Keep as is", or the message was closed
  }
}

// Re-check the open project when a video's backend appears or changes (a
// missing file located, a new video added) and after edits. Cheap: answered
// and non-MP4 videos are skipped before any per-frame work, and nothing is
// probed. Deferred to a macrotask so it runs after every update listener.
let scheduled = false;
function scheduleRecheck(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    const labels = useAppStore.getState().labels;
    if (labels) void runEditListCheck(labels, defaultDeps, { probe: false });
  }, 0);
}
// Guarded: tests that stub the command context or store without these hooks
// must still be able to import this module.
if (typeof commandContext?.onUpdate === "function") commandContext.onUpdate(scheduleRecheck);
if (typeof useAppStore?.subscribe === "function") {
  useAppStore.subscribe((s) => s.videoRevision, scheduleRecheck);
  useAppStore.subscribe((s) => s.backendSwapNonce, scheduleRecheck);
}
