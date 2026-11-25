/**
 * Zustand store driving {@link SlpFormatRefusalDialog}.
 *
 * Kept separate from `appStore` so refusal UI state is never persisted and
 * never mutates project state. Also carries a lightweight counter used when
 * Desktop `[Upgrade]` is clicked from the Welcome screen (where the sidebar
 * is not mounted yet).
 */

import { create } from "zustand";
import type { SlpFormatRefusal } from "@/lib/slpFormatRefusal";

interface SlpFormatDialogStore {
  refusal: SlpFormatRefusal | null;
  welcomeEnvironmentRequestSeq: number;
  open: (refusal: SlpFormatRefusal) => void;
  close: () => void;
  requestWelcomeEnvironment: () => void;
}

export const useSlpFormatDialogStore = create<SlpFormatDialogStore>((set) => ({
  refusal: null,
  welcomeEnvironmentRequestSeq: 0,
  open: (refusal) => set({ refusal }),
  close: () => set({ refusal: null }),
  requestWelcomeEnvironment: () =>
    set((s) => ({
      welcomeEnvironmentRequestSeq: s.welcomeEnvironmentRequestSeq + 1,
    })),
}));
