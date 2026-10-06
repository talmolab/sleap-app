/**
 * Tracks the currently-running desktop legacy-codec transcode so the UI can show
 * a progress dialog with a Cancel button. Only one transcode runs at a time (the
 * add-video / resolve paths are sequential), so a single active job suffices.
 *
 * The video-resolution layer (`resolveVideos.ts createBackendForPath`) drives
 * this: `startJob` when a conversion actually begins, `setProgress` from ffmpeg
 * `-progress`, and `endJob` on completion/cancel/failure. `requestCancel` fires
 * the AbortController wired into the transcode.
 */

import { create } from "zustand";

export interface TranscodeJobView {
  /** Basename of the video being converted (for display). */
  name: string;
  /** 0–100 when the source duration is known, else null (indeterminate). */
  percent: number | null;
  /** Frames processed so far, if reported. */
  frame: number | null;
  /** True once the user has clicked Cancel (disables the button). */
  canceling: boolean;
}

interface TranscodeStore {
  job: TranscodeJobView | null;
  /** Abort the running transcode; set alongside the job. */
  cancel: (() => void) | null;
  startJob: (name: string, cancel: () => void) => void;
  setProgress: (percent: number | null, frame: number | null) => void;
  requestCancel: () => void;
  endJob: () => void;
}

export const useTranscodeStore = create<TranscodeStore>((set, get) => ({
  job: null,
  cancel: null,
  startJob: (name, cancel) =>
    set({ job: { name, percent: null, frame: null, canceling: false }, cancel }),
  setProgress: (percent, frame) =>
    set((s) => (s.job ? { job: { ...s.job, percent, frame } } : {})),
  requestCancel: () => {
    const c = get().cancel;
    if (!c) return;
    set((s) => (s.job ? { job: { ...s.job, canceling: true } } : {}));
    c();
  },
  endJob: () => set({ job: null, cancel: null }),
}));
