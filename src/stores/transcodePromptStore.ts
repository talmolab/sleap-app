/**
 * Drives the "convert this legacy video?" confirmation shown BEFORE a desktop
 * transcode begins (the user asked to opt in, not have it happen automatically).
 *
 * `confirm(key, name, codec)` returns a promise that resolves `true` (Convert) or
 * `false` (Skip) once the user answers {@link TranscodeConfirmDialog}. Video
 * resolution is sequential, so at most one prompt is pending at a time; the
 * `inFlight` map additionally collapses the React-StrictMode double-invoke (two
 * concurrent opens of the same video) onto a single dialog + shared answer.
 *
 * Distinct from {@link useTranscodeStore}, which shows PROGRESS once a conversion
 * the user accepted is actually running.
 */

import { create } from "zustand";

export interface TranscodePromptView {
  /** Stable key (the source path) — dedups concurrent prompts for one video. */
  key: string;
  /** Basename shown in the dialog. */
  name: string;
  /** Probed source codec (e.g. "mpeg4", "wmv3") for a friendly label. */
  codec: string;
}

interface TranscodePromptStore {
  pending: TranscodePromptView | null;
  /**
   * Ask whether to convert `key` (source path). Resolves true=Convert,
   * false=Skip. Concurrent calls for the same key share one prompt/answer.
   */
  confirm: (key: string, name: string, codec: string) => Promise<boolean>;
  /** Answer the active prompt (from the dialog buttons). */
  respond: (accept: boolean) => void;
}

// Kept outside the store: the pending resolver is single (sequential resolution)
// and the in-flight map dedups StrictMode's concurrent same-key calls. Neither is
// render state, so they don't belong in the zustand snapshot.
let activeResolve: ((accept: boolean) => void) | null = null;
const inFlight = new Map<string, Promise<boolean>>();

export const useTranscodePromptStore = create<TranscodePromptStore>((set) => ({
  pending: null,
  confirm: (key, name, codec) => {
    const existing = inFlight.get(key);
    if (existing) return existing; // same video already being asked about
    const promise = new Promise<boolean>((resolve) => {
      activeResolve = resolve;
      set({ pending: { key, name, codec } });
    });
    inFlight.set(key, promise);
    void promise.finally(() => inFlight.delete(key));
    return promise;
  },
  respond: (accept) => {
    const resolve = activeResolve;
    activeResolve = null;
    set({ pending: null });
    resolve?.(accept);
  },
}));
