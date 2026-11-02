/**
 * Frame-check results per video, for this session only (never saved in the
 * `.slp`): the quick check, which runs whenever a video's backend opens, and
 * the full check the user runs from the Videos panel. Keyed by the Video
 * object; a quick result also remembers which backend it judged, so a swapped
 * backend (scrub proxy, worker decode) is judged again.
 *
 * `dialogVideo` is the video the Check Frames dialog is open for.
 */
import { create } from "zustand";
import type { Video } from "@/types";
import {
  frameCheckPassed,
  type FrameCheckResult,
  type QuickCheckResult,
} from "@/lib/videoCheck";

export interface VideoCheckEntry {
  quick: QuickCheckResult | null;
  /** The backend `quick` was computed from. */
  quickBackend: unknown;
  full: FrameCheckResult | null;
}

interface VideoCheckStore {
  results: Map<Video, VideoCheckEntry>;
  dialogVideo: Video | null;
  setQuick: (video: Video, backend: unknown, quick: QuickCheckResult) => void;
  setFull: (video: Video, full: FrameCheckResult) => void;
  openDialog: (video: Video) => void;
  closeDialog: () => void;
}

const EMPTY: VideoCheckEntry = { quick: null, quickBackend: null, full: null };

export const useVideoCheckStore = create<VideoCheckStore>((set) => ({
  results: new Map(),
  dialogVideo: null,
  setQuick: (video, backend, quick) =>
    set((s) => {
      const results = new Map(s.results);
      results.set(video, { ...(s.results.get(video) ?? EMPTY), quick, quickBackend: backend });
      return { results };
    }),
  setFull: (video, full) =>
    set((s) => {
      const results = new Map(s.results);
      results.set(video, { ...(s.results.get(video) ?? EMPTY), full });
      return { results };
    }),
  openDialog: (video) => set({ dialogVideo: video }),
  closeDialog: () => set({ dialogVideo: null }),
}));

/** The video's ⚠ state: a failed full check, or a quick check that warned. */
export function videoCheckWarns(entry: VideoCheckEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.full) return !frameCheckPassed(entry.full);
  return entry.quick?.status === "warn";
}
