/**
 * Main application state store.
 *
 * Mirrors SLEAP's GuiState pattern: a reactive key-value store with
 * subscriptions that trigger on value changes.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  Labels,
  LabeledFrame,
  Instance,
  Skeleton,
  Track,
  Video,
  EdgeStyle,
  ColorTarget,
  InstancePlacementMethod,
} from "../types";

export interface AppState {
  // === Project state ===
  labels: Labels | null;
  filename: string | null;
  projectPath: string | null;
  hasChanges: boolean;
  projectLoaded: boolean;

  // === Selection state ===
  video: Video | null;
  frameIdx: number;
  instance: Instance | null;
  labeledFrame: LabeledFrame | null;
  skeleton: Skeleton | null;
  lastInteractedFrame: number | null;

  // === UI layout state ===
  uiScale: number;
  sidebarCollapsed: boolean;
  sidebarActivePanel: string;
  panelOrder: string[];

  // === View state ===
  showInstances: boolean;
  showLabels: boolean;
  showEdges: boolean;
  showNonVisibleNodes: boolean;
  edgeStyle: EdgeStyle;
  fit: boolean;
  fitSelection: boolean;
  colorPredicted: boolean;
  defaultToPan: boolean;
  palette: string;
  distinctlyColor: ColorTarget;
  markerSize: number;
  nodeLabelSize: number;
  insetSize: number;
  insetZoom: number;
  trailLength: number;
  trailShade: string;
  lutMin: number;
  lutMax: number;
  frameHistogram: Uint32Array | null;
  colormap: string;
  rotation: 0 | 90 | 180 | 270;

  // === Editing state ===
  instanceInitMethod: InstancePlacementMethod;
  clipboardTrack: Track | null;
  clipboardInstance: Instance | null;

  // === Labeling mode state (transient, not persisted) ===
  labelingMode: "select" | "place";
  placementNodeIdx: number | null;

  // === Frame range ===
  frameRange: [number, number] | null;
  hasFrameRange: boolean;

  // === Loading state ===
  isLoading: boolean;
  loadingMessage: string;

  // === Dialog state ===
  trainingDialogOpen: boolean;
  inferenceDialogOpen: boolean;
  goToFrameDialogOpen: boolean;
  deletePredictionsDialogOpen: boolean;
  exportDialogOpen: boolean;
  shortcutsDialogOpen: boolean;
  helpDialogOpen: boolean;

  // === Debug ===
  debugMode: boolean;

  // === Overlay version ===
  overlayVersion: number;

  // === Actions ===
  setLabels: (labels: Labels, filename?: string, projectPath?: string) => void;
  setVideo: (video: Video) => void;
  setFrameIdx: (idx: number) => void;
  incrementFrameIdx: (step: number) => void;
  setInstance: (instance: Instance | null) => void;
  setLabeledFrame: (frame: LabeledFrame | null) => void;
  markChanged: () => void;
  clearChanges: () => void;
  setLoading: (loading: boolean, message?: string) => void;
  setTrainingDialogOpen: (open: boolean) => void;
  setInferenceDialogOpen: (open: boolean) => void;
  setGoToFrameDialogOpen: (open: boolean) => void;
  setDeletePredictionsDialogOpen: (open: boolean) => void;
  setExportDialogOpen: (open: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setHelpDialogOpen: (open: boolean) => void;
  enterPlacementMode: () => void;
  exitPlacementMode: () => void;
  toggle: (key: keyof AppState) => void;
  set: <K extends keyof AppState>(key: K, value: AppState[K]) => void;
  bumpOverlayVersion: () => void;
}

/** Keys persisted to localStorage for user preferences. */
const PERSISTED_KEYS: (keyof AppState)[] = [
  "palette",
  "edgeStyle",
  "markerSize",
  "nodeLabelSize",
  "showLabels",
  "showEdges",
  "showNonVisibleNodes",
  "colorPredicted",
  "trailLength",
  "insetSize",
  "insetZoom",
  "defaultToPan",
];

export const useAppStore = create<AppState>()(
  subscribeWithSelector(
    persist(
    immer((set, get) => ({
      // Project state
      labels: null,
      filename: null,
      projectPath: null,
      hasChanges: false,
      projectLoaded: false,

      // Selection state
      video: null,
      frameIdx: 0,
      instance: null,
      labeledFrame: null,
      skeleton: null,
      lastInteractedFrame: null,

      // UI layout state
      uiScale: 1,
      sidebarCollapsed: false,
      sidebarActivePanel: "videos",
      panelOrder: ["videos", "skeleton", "instances", "view", "suggestions", "inference", "environment", "notifications", "debug"],

      // View state
      showInstances: true,
      showLabels: true,
      showEdges: true,
      showNonVisibleNodes: true,
      edgeStyle: "Line" as EdgeStyle,
      fit: false,
      fitSelection: false,
      colorPredicted: false,
      defaultToPan: false,
      palette: "standard",
      distinctlyColor: "track" as ColorTarget,
      markerSize: 4,
      nodeLabelSize: 12,
      insetSize: 200,
      insetZoom: 4,
      trailLength: 0,
      trailShade: "Normal",
      lutMin: 0,
      lutMax: 255,
      frameHistogram: null,
      colormap: "grayscale",
      rotation: 0 as 0 | 90 | 180 | 270,

      // Editing state
      instanceInitMethod: "best" as InstancePlacementMethod,
      clipboardTrack: null,
      clipboardInstance: null,

      // Labeling mode state (transient)
      labelingMode: "select" as "select" | "place",
      placementNodeIdx: null as number | null,

      // Frame range
      frameRange: null,
      hasFrameRange: false,

      // Loading state
      isLoading: false,
      loadingMessage: "",

      // Dialog state
      trainingDialogOpen: false,
      inferenceDialogOpen: false,
      goToFrameDialogOpen: false,
      deletePredictionsDialogOpen: false,
      exportDialogOpen: false,
      shortcutsDialogOpen: false,
      helpDialogOpen: false,

      // Debug
      debugMode: false,

      // Overlay version (bumped to force re-render)
      overlayVersion: 0,

      // Actions
      setLabels: (labels, filename, projectPath) =>
        set((state) => {
          state.labels = labels;
          state.filename = filename ?? null;
          state.projectPath = projectPath ?? null;
          state.projectLoaded = true;
          state.hasChanges = false;

          // Set first video and skeleton
          if (labels.videos.length > 0) {
            state.video = labels.videos[0];
          }
          if (labels.skeletons.length > 0) {
            state.skeleton = labels.skeletons[0];
          }
          state.frameIdx = 0;
          state.instance = null;
          state.labeledFrame = null;
        }),

      setVideo: (video) =>
        set((state) => {
          state.video = video;
          state.frameIdx = 0;
          state.instance = null;
          state.labeledFrame = null;
        }),

      setFrameIdx: (idx) =>
        set((state) => {
          const video = state.video;
          if (video && video.shape) {
            const maxFrame = (video.shape[0] ?? 1) - 1;
            state.frameIdx = Math.max(0, Math.min(idx, maxFrame));
          } else {
            // No shape info — allow any non-negative index
            state.frameIdx = Math.max(0, idx);
          }
          state.instance = null;
          // Compute labeledFrame synchronously to avoid race condition during fast scrubbing
          if (state.labels && state.video) {
            const frames = state.labels.find({ video: state.video as Video, frameIdx: state.frameIdx });
            state.labeledFrame = frames.length > 0 ? frames[0] : null;
          } else {
            state.labeledFrame = null;
          }
        }),

      incrementFrameIdx: (step) => {
        const { video, frameIdx } = get();
        if (!video) return;
        const maxFrame = video.shape ? (video.shape[0] ?? 1) - 1 : Infinity;
        let newIdx = frameIdx + step;
        if (maxFrame !== Infinity) {
          // Wrap around
          if (newIdx < 0) newIdx = maxFrame;
          if (newIdx > maxFrame) newIdx = 0;
        } else {
          if (newIdx < 0) newIdx = 0;
        }
        get().setFrameIdx(newIdx);
      },

      setInstance: (instance) =>
        set((state) => {
          state.instance = instance;
        }),

      setLabeledFrame: (frame) =>
        set((state) => {
          state.labeledFrame = frame;
        }),

      markChanged: () =>
        set((state) => {
          state.hasChanges = true;
          state.lastInteractedFrame = state.frameIdx;
        }),

      clearChanges: () =>
        set((state) => {
          state.hasChanges = false;
        }),

      setLoading: (loading, message) =>
        set((state) => {
          state.isLoading = loading;
          state.loadingMessage = message ?? "";
        }),

      setTrainingDialogOpen: (open) =>
        set((state) => {
          state.trainingDialogOpen = open;
        }),

      setInferenceDialogOpen: (open) =>
        set((state) => {
          state.inferenceDialogOpen = open;
        }),

      setGoToFrameDialogOpen: (open) =>
        set((state) => {
          state.goToFrameDialogOpen = open;
        }),

      setDeletePredictionsDialogOpen: (open) =>
        set((state) => {
          state.deletePredictionsDialogOpen = open;
        }),

      setExportDialogOpen: (open) =>
        set((state) => {
          state.exportDialogOpen = open;
        }),

      setShortcutsDialogOpen: (open) =>
        set((state) => {
          state.shortcutsDialogOpen = open;
        }),

      setHelpDialogOpen: (open) =>
        set((state) => {
          state.helpDialogOpen = open;
        }),

      enterPlacementMode: () =>
        set((state) => {
          const inst = state.instance;
          if (!inst) return;
          state.labelingMode = "place";
          // Find first unplaced node
          const firstNaN = inst.points.findIndex(
            (p) => isNaN(p.xy[0]) || isNaN(p.xy[1])
          );
          state.placementNodeIdx = firstNaN !== -1 ? firstNaN : 0;
        }),

      exitPlacementMode: () =>
        set((state) => {
          state.labelingMode = "select";
          state.placementNodeIdx = null;
        }),

      toggle: (key) =>
        set((state) => {
          const val = state[key];
          if (typeof val === "boolean") {
            (state as Record<string, unknown>)[key] = !val;
          }
        }),

      set: (key, value) =>
        set((state) => {
          (state as Record<string, unknown>)[key] = value;
        }),

      bumpOverlayVersion: () =>
        set((state) => {
          state.overlayVersion += 1;
        }),
    })),
    {
      name: "sleap-app-preferences",
      partialize: (state) =>
        Object.fromEntries(
          PERSISTED_KEYS.map((key) => [key, state[key]])
        ) as Partial<AppState>,
    },
    )
  )
);
