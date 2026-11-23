/**
 * Open-time check for labels made before frames were numbered like ffmpeg
 * (sleap-io.js #274). See `editListShift.ts` for the background.
 *
 * Flow for an opened `.slp` (or restored draft):
 *  1. `expectEditListCheck(labels)` before `setLabels`, so the auto-stamp below
 *     leaves it alone until the check has run.
 *  2. `runEditListCheck(labels)` after it is installed: if the file has no
 *     frame-index marker, open its MP4/MOV videos that have user labels (they
 *     may be deferred until first view), and for each video whose edit list
 *     hides frames, ask: shift its labels earlier, keep them, or ask later.
 *     Nothing is ever shifted without the user's choice.
 *  3. Once every such video is answered, stamp the marker so the question is
 *     not asked again after the next save.
 *
 * Every other project installed in the store (New Project, imports from other
 * tools) was numbered by this version or by an ffmpeg-based tool, so it is
 * stamped right away.
 */

import { useAppStore } from "@/stores/appStore";
import { choiceDialog, type ChoiceRequest } from "@/stores/choiceStore";
import { commandContext } from "@/commands/CommandContext";
import { ShiftVideoLabelsCommand } from "@/commands/editListCommands";
import type { Labels, Video } from "../types";
import {
  canHaveEditList,
  findEditListCandidates,
  hasFrameIndexMarker,
  hasShiftableContent,
  stampFrameIndexMarker,
  type EditListCandidate,
} from "./editListShift";
import { ensureVideoBackend } from "./resolveVideos";

/** Opened projects whose check hasn't finished: the auto-stamp skips them. */
const pendingChecks = new WeakSet<Labels>();

/** Mark an opened `.slp` as needing the check; call BEFORE `setLabels`. */
export function expectEditListCheck(labels: Labels): void {
  pendingChecks.add(labels);
}

// Auto-stamp every project installed WITHOUT a pending check (New Project,
// imports): its frame numbers come from this version or an ffmpeg-based tool.
useAppStore.subscribe(
  (s) => s.labels,
  (labels) => {
    if (labels && !pendingChecks.has(labels)) stampFrameIndexMarker(labels);
  }
);

/** Choice keys returned by the prompt. */
export const SHIFT_CHOICE = "shift";
export const KEEP_CHOICE = "keep";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function videoName(video: Video): string {
  const f = Array.isArray(video.filename) ? (video.filename[0] ?? "") : video.filename;
  return f.split(/[\\/]/).pop() || "this video";
}

/** The prompt for one video (plain language; exported for tests). */
export function buildShiftPrompt(c: EditListCandidate): ChoiceRequest {
  const n = c.hidden;
  const frames = plural(n, "frame");
  const { plan } = c;
  const lines: string[] = [
    `This video starts with ${plural(n, "hidden frame")}: ${n === 1 ? "a frame" : "frames"} the file keeps only so the next frames can be decoded (common after cutting a video with ffmpeg's stream copy). ffmpeg and SLEAP (Python) skip ${n === 1 ? "it" : "them"}, and this version of the app now does too. Earlier versions counted ${n === 1 ? "it" : "them"}.`,
    "",
    `If you labeled this video in an earlier version of this app, its labels now sit ${frames} after the image they were made on. Shifting moves them ${frames} earlier:`,
  ];
  if (plan.movedFrames > 0) {
    lines.push(
      `• ${plural(plan.movedFrames, "labeled frame")} (your instances, boxes, masks and negative-frame marks)`
    );
  }
  if (plan.movedSuggestions > 0) lines.push(`• ${plural(plan.movedSuggestions, "suggestion")}`);
  const dropped: string[] = [];
  if (plan.droppedFrames > 0) dropped.push(plural(plan.droppedFrames, "labeled frame"));
  if (plan.droppedSuggestions > 0) dropped.push(plural(plan.droppedSuggestions, "suggestion"));
  if (dropped.length > 0) {
    lines.push(
      `• ${dropped.join(" and ")} on the hidden ${n === 1 ? "frame" : "frames"} will be removed (nothing is shown there).`
    );
  }
  if (plan.framesWithPredictionsKept > 0) {
    lines.push("Predictions stay where they are: SLEAP and sleap-nn already number frames this way.");
  }
  lines.push(
    "",
    "If these labels were made in SLEAP (Python) or another tool, keep them as they are. You can undo the shift with Edit → Undo."
  );
  return {
    title: `Frame numbers changed for “${videoName(c.video)}”`,
    message: lines.join("\n"),
    options: [
      { key: KEEP_CHOICE, label: "Keep as is" },
      { key: SHIFT_CHOICE, label: `Shift ${frames} earlier`, primary: true },
    ],
    cancelLabel: "Ask me later",
  };
}

/** Injected seams (tests). */
export interface EditListCheckDeps {
  /** Open a lazily-deferred video's backend; false if it can't be opened. */
  ensureBackend: (video: Video) => Promise<boolean>;
  /** Ask the user; resolves a choice key or null ("Ask me later"). */
  choose: (req: ChoiceRequest) => Promise<string | null>;
  /** Run the undoable shift. */
  shift: (video: Video, by: number) => Promise<void>;
  /** The project currently open (the check stops if it changes). */
  currentLabels: () => Labels | null;
}

const defaultDeps: EditListCheckDeps = {
  ensureBackend: ensureVideoBackend,
  choose: choiceDialog,
  shift: (video, by) => commandContext.execute(ShiftVideoLabelsCommand, { video, by }),
  currentLabels: () => useAppStore.getState().labels,
};

/**
 * Run the check for an opened project (see the module doc). Fire-and-forget;
 * never throws. Resolves once every prompt is answered.
 */
export async function runEditListCheck(
  labels: Labels,
  deps: EditListCheckDeps = defaultDeps
): Promise<void> {
  try {
    if (hasFrameIndexMarker(labels)) return;
    const stillOpen = () => deps.currentLabels() === labels;

    // Desktop defers each video's decoder until it is first viewed; open the
    // MP4/MOV videos that have something to shift so their edit lists can be read.
    for (const video of labels.videos) {
      if (video.backend || !canHaveEditList(video)) continue;
      if (!hasShiftableContent(labels, video)) continue;
      await deps.ensureBackend(video);
      if (!stillOpen()) return;
    }

    const { candidates, uncheckedVideos } = findEditListCandidates(labels);
    // A video we couldn't open (missing file) is still unanswered: keep asking
    // on later opens instead of stamping the file as done.
    let unanswered = uncheckedVideos > 0;
    for (const candidate of candidates) {
      if (!stillOpen()) return;
      const choice = await deps.choose(buildShiftPrompt(candidate));
      if (!stillOpen()) return;
      if (choice === SHIFT_CHOICE) await deps.shift(candidate.video, candidate.hidden);
      else if (choice !== KEEP_CHOICE) unanswered = true;
    }
    if (!unanswered && stillOpen()) stampFrameIndexMarker(labels);
  } catch (err) {
    console.warn("[edit-list] open-time check failed:", err);
  } finally {
    pendingChecks.delete(labels);
  }
}
