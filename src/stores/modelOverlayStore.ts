/**
 * Compare model predictions: the models being shown.
 *
 * Each entry is one prediction file the user picked in Predict ▸ Compare Model
 * Predictions…, already checked against the project (same video, same node
 * names) and reduced to its poses on that video (see lib/modelOverlay/core.ts).
 * View only and session only: nothing here is saved or written to the project,
 * and everything is dropped when a different project loads.
 */
import { create } from "zustand";
import type { Labels, Video } from "@/types";
import type { RGB } from "@/lib/colorPalettes";
import { nextModelColor, uniqueModelName, type OverlayPose } from "@/lib/modelOverlay/core";
import { useAppStore } from "@/stores/appStore";

export interface OverlayModel {
  id: string;
  /** Shown in the legend: from the file's provenance, else its file name. */
  name: string;
  /** Where it came from: a path on desktop, a file name in the browser. */
  source: string;
  color: RGB;
  visible: boolean;
  /** The project video these poses belong to. */
  video: Video;
  /** Poses per frame, in the project's node order. */
  frames: Map<number, OverlayPose[]>;
}

export interface NewOverlayModel {
  name: string;
  source: string;
  video: Video;
  frames: Map<number, OverlayPose[]>;
}

interface ModelOverlayState {
  models: OverlayModel[];
  /** The project the models were checked against. */
  labels: Labels | null;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Add models (a source already shown is replaced in place, keeping its colour). */
  addModels: (labels: Labels, models: NewOverlayModel[]) => void;
  removeModel: (id: string) => void;
  setVisible: (id: string, visible: boolean) => void;
  clear: () => void;
}

let nextId = 1;

export const useModelOverlayStore = create<ModelOverlayState>()((set) => ({
  models: [],
  labels: null,
  dialogOpen: false,
  setDialogOpen: (open) => set({ dialogOpen: open }),
  addModels: (labels, added) =>
    set((s) => {
      const models = s.labels === labels ? [...s.models] : [];
      for (const m of added) {
        const at = models.findIndex((x) => x.source === m.source && x.video === m.video);
        if (at >= 0) {
          models[at] = { ...models[at], name: m.name, frames: m.frames, visible: true };
          continue;
        }
        const name = uniqueModelName(
          m.name,
          models.map((x) => x.name)
        );
        const color = nextModelColor(
          models.map((x) => x.color),
          models.length
        );
        models.push({ id: `model-${nextId++}`, name, source: m.source, color, visible: true, video: m.video, frames: m.frames });
      }
      return { labels, models };
    }),
  removeModel: (id) => set((s) => ({ models: s.models.filter((m) => m.id !== id) })),
  setVisible: (id, visible) =>
    set((s) => ({ models: s.models.map((m) => (m.id === id ? { ...m, visible } : m)) })),
  clear: () => set({ models: [], labels: null }),
}));

// A different project: its videos aren't the ones these poses were matched to.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels && useModelOverlayStore.getState().models.length > 0) {
    useModelOverlayStore.getState().clear();
  }
});
