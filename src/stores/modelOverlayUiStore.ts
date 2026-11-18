/**
 * Compare Model Predictions: pointer/selection state for the panel and the
 * canvas — which model's row is selected (its poses get dashed boxes) and
 * which model pose the pointer is over (hover highlight + label). Session
 * only. Kept apart from modelOverlayStore so the loaded models (big, slow to
 * reload) aren't touched by this fast-changing state.
 */
import { create } from "zustand";

/** The model pose under the pointer. `node` is null when over its body, not a node. */
export interface ModelPoseHover {
  modelId: string;
  pose: number;
  node: number | null;
  clientX: number;
  clientY: number;
}

interface ModelOverlayUiState {
  /** The model whose row is selected in the panel, or null. */
  selectedModelId: string | null;
  /** Select a model; selecting the selected one again deselects it. */
  toggleSelectedModel: (id: string) => void;
  clearSelectedModel: () => void;
  hover: ModelPoseHover | null;
  setHover: (hover: ModelPoseHover | null) => void;
}

export const useModelOverlayUiStore = create<ModelOverlayUiState>()((set) => ({
  selectedModelId: null,
  toggleSelectedModel: (id) => set((s) => ({ selectedModelId: s.selectedModelId === id ? null : id })),
  clearSelectedModel: () => set({ selectedModelId: null }),
  hover: null,
  setHover: (hover) => set({ hover }),
}));
