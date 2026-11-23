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
import { nextModelColor, uniqueModelName } from "@/lib/modelOverlay/core";
import { trackNamesOf, type PoseFrames } from "@/lib/modelOverlay/poseStore";
import type { TraceTarget } from "@/lib/modelOverlay/traces";
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
  frames: PoseFrames;
  /** Every track name in the file (empty when it has no tracks). */
  trackNames: Set<string>;
}

/** A model pose picked on the canvas (click), for Accept. */
export interface SelectedModelPose {
  modelId: string;
  video: Video;
  frameIdx: number;
  poseIdx: number;
}

/** Default disagreement threshold, pixels of spread across models. */
export const DEFAULT_DISAGREEMENT_PX = 10;

export interface NewOverlayModel {
  name: string;
  source: string;
  video: Video;
  frames: PoseFrames;
}

interface ModelOverlayState {
  models: OverlayModel[];
  /** The project the models were checked against. */
  labels: Labels | null;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Ring nodes where the models disagree by more than `threshold` px. */
  highlightDisagreement: boolean;
  threshold: number;
  setHighlightDisagreement: (on: boolean) => void;
  setThreshold: (px: number) => void;
  /** The model pose clicked on the canvas (Accept bar), if any. */
  selected: SelectedModelPose | null;
  setSelected: (sel: SelectedModelPose | null) => void;
  /** The corner panel folded into a small pill (models stay drawn). */
  legendMinimized: boolean;
  setLegendMinimized: (minimized: boolean) => void;
  /** The per-node traces strip under the video. */
  tracesOpen: boolean;
  setTracesOpen: (open: boolean) => void;
  /** Node (project node index) and animal the traces show. */
  traceNode: number;
  traceTarget: TraceTarget;
  setTraceNode: (node: number) => void;
  setTraceTarget: (target: TraceTarget) => void;
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
  highlightDisagreement: true,
  threshold: DEFAULT_DISAGREEMENT_PX,
  setHighlightDisagreement: (on) => set({ highlightDisagreement: on }),
  // Invalid input (NaN, negative) is ignored: the threshold keeps its value.
  setThreshold: (px) => set((s) => ({ threshold: Number.isFinite(px) && px >= 0 ? px : s.threshold })),
  selected: null,
  setSelected: (sel) => set({ selected: sel }),
  legendMinimized: false,
  setLegendMinimized: (minimized) => set({ legendMinimized: minimized }),
  tracesOpen: false,
  setTracesOpen: (open) => set({ tracesOpen: open }),
  traceNode: 0,
  traceTarget: { kind: "animal", index: 0 },
  setTraceNode: (node) => set({ traceNode: node }),
  setTraceTarget: (target) => set({ traceTarget: target }),
  addModels: (labels, added) =>
    set((s) => {
      const models = s.labels === labels ? [...s.models] : [];
      for (const m of added) {
        const at = models.findIndex((x) => x.source === m.source && x.video === m.video);
        if (at >= 0) {
          models[at] = { ...models[at], name: m.name, frames: m.frames, trackNames: trackNamesOf(m.frames), visible: true };
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
        models.push({
          id: `model-${nextId++}`,
          name,
          source: m.source,
          color,
          visible: true,
          video: m.video,
          frames: m.frames,
          trackNames: trackNamesOf(m.frames),
        });
      }
      return { labels, models, selected: null };
    }),
  removeModel: (id) =>
    set((s) => ({
      models: s.models.filter((m) => m.id !== id),
      selected: s.selected?.modelId === id ? null : s.selected,
    })),
  setVisible: (id, visible) =>
    set((s) => ({
      models: s.models.map((m) => (m.id === id ? { ...m, visible } : m)),
      selected: s.selected?.modelId === id && !visible ? null : s.selected,
    })),
  clear: () => set({ models: [], labels: null, selected: null, tracesOpen: false }),
}));

// A different project: its videos aren't the ones these poses were matched to.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels && useModelOverlayStore.getState().models.length > 0) {
    useModelOverlayStore.getState().clear();
  }
  // A picked pose belongs to the frame it was picked on.
  const sel = useModelOverlayStore.getState().selected;
  if (sel && (s.frameIdx !== sel.frameIdx || s.video !== sel.video)) {
    useModelOverlayStore.getState().setSelected(null);
  }
});
