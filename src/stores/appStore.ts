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
import { enableMapSet, type Draft } from "immer";
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
import type { StatisticGraphType, Reduction } from "@/lib/statisticSeries";
import type { QcMode } from "@/lib/instanceVisibility";
import {
  navigableDomain,
  stepLabeled,
  type NavigationDomain,
} from "@/lib/navigableFrames";
export type { NavigationDomain };
import {
  DEFAULT_PANEL_ORDER,
  reconcilePanelOrder,
  reconcileHiddenPanels,
  nextVisiblePanel,
} from "@/lib/panelLayout";
import { hydrateActiveLearningStore } from "@/lib/activeLearning/persistence";
import {
  advance as advancePassCursor,
  stepBack as stepBackPassCursor,
  initialCursor as initialPassCursor,
  finalCursor as finalPassCursor,
  nextUnlabeledCursor,
  resolveItemInstance,
  type PassItem,
  type PassCursor,
  type PassDims,
} from "@/lib/activeLearning/passEngine";
export type { PassItem, PassCursor, PassDims };

// Required before immer can draft Set/Map fields (hiddenInstances /
// showNonVisibleOverride). Idempotent global; must run before store creation.
enableMapSet();

/**
 * Reset the transient per-instance visibility fields on an immer draft. Shared
 * by the initializer, frame/video changes, project load, and the explicit
 * reset action so the lifecycle stays in one place.
 */
function clearTransientVisibility(state: Draft<AppState>) {
  state.hiddenInstances = new Set<Instance>();
  state.viewOnlyInstance = null;
  state.showNonVisibleOverride = new Map<Instance, boolean>();
}

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
  frameInteractionStack: string[];

  // === UI layout state ===
  uiScale: number;
  sidebarCollapsed: boolean;
  /** Which side the panel sidebar docks on (#UX-wins). Persisted. */
  sidebarSide: "left" | "right";
  sidebarActivePanel: string;
  panelOrder: string[];
  hiddenPanels: string[];

  // === View state ===
  showInstances: boolean;
  showLabels: boolean;
  showEdges: boolean;
  showNonVisibleNodes: boolean;
  /** Show a full-canvas crosshair at the cursor while zoomed in (#UX-wins). Persisted. */
  showCrosshair: boolean;
  edgeStyle: EdgeStyle;
  fit: boolean;
  fitSelection: boolean;
  /**
   * One-shot request to pan the viewport so the selected instance is centered,
   * at the current zoom (unlike `fitSelection`, which also zooms to fit). Set
   * from the Instances panel on click; VideoPlayer consumes and clears it.
   * Transient — not persisted.
   */
  centerSelection: boolean;
  /**
   * Monotonically-increasing one-shot signal to reset the main video canvas
   * view to its default (zoom = 1, no pan, fit-frame). Bumped by `resetView`
   * from the toolbar button / `R` hotkey; VideoPlayer subscribes and applies
   * the reset when it changes. A nonce (not a boolean) so back-to-back resets
   * each fire without a separate clear step. Transient — not persisted.
   */
  resetViewNonce: number;
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
  /** Auto-contrast: derive the LUT from each frame's histogram (per-frame stretch). */
  autoContrast: boolean;
  frameHistogram: Uint32Array | null;
  /**
   * True while VideoPlayer has a frame read in flight. Transient (never
   * persisted); read via getState() — do NOT subscribe with a selector or it
   * will re-render on every frame. Used by the seekbar scrub loop to serialize
   * reads: it never issues a new frame while one is loading, so a drag tracks
   * the cursor with one read of latency instead of a growing backlog (#137 perf).
   */
  frameLoading: boolean;
  /**
   * True while the user is dragging the seekbar (scrubbing). Transient (never
   * persisted); read via getState(), don't subscribe. Lets VideoPlayer skip
   * expensive per-frame work (the histogram) during a fast scrub, which would
   * otherwise churn ~10 MB/frame and can OOM-crash the WebView renderer.
   */
  isScrubbing: boolean;
  colormap: string;
  rotation: 0 | 90 | 180 | 270;
  seekbarHeaderGraph: StatisticGraphType;
  seekbarHeaderReduction: Reduction;
  /** Which frames stepping/playback/seekbar are confined to (#137). */
  navigationDomain: NavigationDomain;

  // Per-instance visibility (transient; reset on frame change; NOT persisted)
  hiddenInstances: Set<Instance>;
  viewOnlyInstance: Instance | null;
  showNonVisibleOverride: Map<Instance, boolean>;
  // Label-QC display mode (persisted app preference)
  qcDisplayMode: QcMode;

  // === Editing state ===
  instanceInitMethod: InstancePlacementMethod;
  clipboardTrack: Track | null;
  clipboardInstance: Instance | null;

  // === Labeling mode state (transient, not persisted) ===
  labelingMode: "select" | "place" | "seed" | "keypointPass";
  placementNodeIdx: number | null;
  /** Skeleton node index a "seed" click places (the centroid/body-center node). */
  seedNodeIdx: number;
  /**
   * When true, a "seed" click creates a first-class `UserCentroid` annotation
   * on `frame.centroids` instead of an Instance point — the centroid-annotation
   * model for a separate (non-keypoint) centroid anchor.
   */
  seedCentroidAnnotation: boolean;

  // === Phase-2 keypoint-pass state (transient, not persisted) ===
  /** Ordered (frame, instance) units the multi-pass sweep walks. */
  passWorkList: PassItem[];
  /** Fixed pass/item/node counts for the current sweep. */
  passDims: PassDims | null;
  /** Skeleton node indices per pass, in click order (`[passIdx][k]`). */
  passNodeIndices: number[][];
  /** Position in the sweep; `null` while active means the sweep is complete. */
  passCursor: PassCursor | null;
  /** Live zoom-to-centroid window (px); adjustable during Phase-2 labeling. */
  passZoomWindow: number;

  // === Frame range ===
  frameRange: [number, number] | null;
  hasFrameRange: boolean;

  // === Loading state ===
  isLoading: boolean;
  loadingMessage: string;
  /**
   * 0–100 determinate load progress for the overlay bar. Transient (not
   * persisted). Set via the 3rd arg of setLoading; reset to 0 when the overlay
   * is dismissed. Stays put across setLoading calls that omit a progress value
   * (e.g. "Locating videos…"), so the bar holds rather than jumping back.
   */
  loadingProgress: number;

  // === Dialog state ===
  inferenceDialogOpen: boolean;
  newProjectDialogOpen: boolean;
  goToFrameDialogOpen: boolean;
  selectToFrameDialogOpen: boolean;
  deletePredictionsDialogOpen: boolean;
  exportDialogOpen: boolean;
  shortcutsDialogOpen: boolean;
  helpDialogOpen: boolean;
  quitConfirmOpen: boolean;

  // === Area delete mode ===
  areaDeleteMode: boolean;

  // === Debug ===
  debugMode: boolean;

  // === Overlay version ===
  overlayVersion: number;

  // Bumped when a video's backend loads late (deferred embedded backend, opened
  // on first view) so the seekbar/status bar re-read the now-corrected
  // `video.shape[0]` (true source frame count vs. the JSON-seeded stand-in).
  videoRevision: number;

  // === Actions ===
  setLabels: (labels: Labels, filename?: string, projectPath?: string) => void;
  setVideo: (video: Video) => void;
  markVideoUpdated: () => void;
  setFrameIdx: (idx: number) => void;
  incrementFrameIdx: (step: number) => void;
  setNavigationDomain: (mode: NavigationDomain) => void;
  cycleNavigationDomain: () => void;
  setInstanceHidden: (instance: Instance, hidden: boolean) => void;
  setViewOnlyInstance: (instance: Instance | null) => void;
  setInstanceInvisibleOverride: (instance: Instance, value: boolean | undefined) => void;
  setQcDisplayMode: (mode: QcMode) => void;
  resetInstanceVisibility: () => void;
  setInstance: (instance: Instance | null) => void;
  setLabeledFrame: (frame: LabeledFrame | null) => void;
  resetView: () => void;
  markChanged: () => void;
  touchFrame: () => void;
  clearChanges: () => void;
  setLoading: (loading: boolean, message?: string, progress?: number) => void;
  setInferenceDialogOpen: (open: boolean) => void;
  setNewProjectDialogOpen: (open: boolean) => void;
  setGoToFrameDialogOpen: (open: boolean) => void;
  setSelectToFrameDialogOpen: (open: boolean) => void;
  setDeletePredictionsDialogOpen: (open: boolean) => void;
  setExportDialogOpen: (open: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setHelpDialogOpen: (open: boolean) => void;
  enterPlacementMode: () => void;
  exitPlacementMode: () => void;
  /**
   * Enter centroid-seeding mode. Each click drops a new one-node instance, or —
   * when `centroidAnnotation` is true — a first-class `UserCentroid` on
   * `frame.centroids`.
   */
  enterSeedMode: (nodeIdx?: number, centroidAnnotation?: boolean) => void;
  exitSeedMode: () => void;
  /** Enter Phase-2 keypoint-pass labeling with a prebuilt work list + dims. */
  enterKeypointPassMode: (args: {
    workList: PassItem[];
    dims: PassDims;
    nodeIndices: number[][];
    zoomWindow?: number;
  }) => void;
  exitKeypointPassMode: () => void;
  /** Advance the pass cursor (place/skip); navigates on item change. */
  passAdvance: () => void;
  /** Step the pass cursor back one node; navigates on item change. */
  passStepBack: () => void;
  /**
   * Jump the pass cursor to the first UNLABELED node (searching from the start),
   * skipping the pre-seeded anchor and anything already decided. Used to resume
   * Phase-2 where labeling left off. Returns true if an unlabeled node was found.
   */
  passJumpToUnlabeled: () => boolean;
  /** Set the zoom-to-centroid window (px) for Phase-2 labeling. */
  setPassZoomWindow: (px: number) => void;
  /** Sync frame/instance selection to the current pass cursor. */
  syncPassSelection: () => void;
  togglePanelVisibility: (panelId: string) => void;
  resetPanels: () => void;
  toggle: (key: keyof AppState) => void;
  set: <K extends keyof AppState>(key: K, value: AppState[K]) => void;
  bumpOverlayVersion: () => void;
}

/** Keys persisted to localStorage for user preferences. */
export const PERSISTED_KEYS: (keyof AppState)[] = [
  "palette",
  "edgeStyle",
  "markerSize",
  "nodeLabelSize",
  "showLabels",
  "showEdges",
  "showNonVisibleNodes",
  "showCrosshair",
  "colorPredicted",
  "autoContrast",
  "trailLength",
  "insetSize",
  "insetZoom",
  "defaultToPan",
  "seekbarHeaderGraph",
  "seekbarHeaderReduction",
  "navigationDomain",
  "qcDisplayMode",
  // Layout + scale persistence (PyQt saveState/restoreState parity).
  "panelOrder",
  "hiddenPanels",
  "sidebarCollapsed",
  "sidebarSide",
  "sidebarActivePanel",
  "uiScale",
];

/**
 * Resolve the persisted navigation mode, migrating the pre-tri-state
 * `navigateLabeledOnly` boolean (#137) to the `navigationDomain` enum. An
 * explicit persisted `navigationDomain` always wins.
 */
export function navigationDomainFromPersisted(p: {
  navigationDomain?: string;
  navigateLabeledOnly?: boolean;
}): NavigationDomain {
  const valid: NavigationDomain[] = ["all", "labeled", "imaged"];
  if (p.navigationDomain && (valid as string[]).includes(p.navigationDomain)) {
    return p.navigationDomain as NavigationDomain;
  }
  // Migrate the pre-tri-state boolean; unknown/corrupt values fall back to "all".
  return p.navigateLabeledOnly ? "labeled" : "all";
}

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
      frameInteractionStack: [],

      // UI layout state
      uiScale: 1,
      sidebarCollapsed: false,
      sidebarSide: "right",
      sidebarActivePanel: "videos",
      panelOrder: [...DEFAULT_PANEL_ORDER],
      hiddenPanels: [],

      // View state
      showInstances: true,
      showLabels: true,
      showEdges: true,
      showNonVisibleNodes: true,
      showCrosshair: false,
      edgeStyle: "Line" as EdgeStyle,
      fit: false,
      fitSelection: false,
      centerSelection: false,
      resetViewNonce: 0,
      colorPredicted: false,
      defaultToPan: false,
      palette: "standard",
      distinctlyColor: "track" as ColorTarget,
      markerSize: 4,
      nodeLabelSize: 12,
      insetSize: 400,
      insetZoom: 4,
      trailLength: 0,
      trailShade: "Normal",
      lutMin: 0,
      lutMax: 255,
      autoContrast: false,
      frameHistogram: null,
      frameLoading: false,
      isScrubbing: false,
      colormap: "grayscale",
      rotation: 0 as 0 | 90 | 180 | 270,
      seekbarHeaderGraph: "instance-count" as StatisticGraphType,
      seekbarHeaderReduction: "sum" as Reduction,
      navigationDomain: "all" as NavigationDomain,

      // Per-instance visibility (transient) + QC display mode (persisted)
      hiddenInstances: new Set<Instance>(),
      viewOnlyInstance: null,
      showNonVisibleOverride: new Map<Instance, boolean>(),
      qcDisplayMode: "manual",

      // Editing state
      instanceInitMethod: "best" as InstancePlacementMethod,
      clipboardTrack: null,
      clipboardInstance: null,

      // Labeling mode state (transient)
      labelingMode: "select" as "select" | "place" | "seed" | "keypointPass",
      placementNodeIdx: null as number | null,
      seedNodeIdx: 0,
      seedCentroidAnnotation: false,

      // Phase-2 keypoint-pass state (transient)
      passWorkList: [] as PassItem[],
      passDims: null as PassDims | null,
      passNodeIndices: [] as number[][],
      passCursor: null as PassCursor | null,
      passZoomWindow: 256,

      // Frame range
      frameRange: null,
      hasFrameRange: false,

      // Loading state
      isLoading: false,
      loadingMessage: "",
      loadingProgress: 0,

      // Dialog state
      inferenceDialogOpen: false,
      newProjectDialogOpen: false,
      goToFrameDialogOpen: false,
      selectToFrameDialogOpen: false,
      deletePredictionsDialogOpen: false,
      exportDialogOpen: false,
      shortcutsDialogOpen: false,
      helpDialogOpen: false,
      quitConfirmOpen: false,

      // Area delete mode
      areaDeleteMode: false,

      // Debug
      debugMode: false,

      // Overlay version (bumped to force re-render)
      overlayVersion: 0,
      videoRevision: 0,

      // Actions
      setLabels: (labels, filename, projectPath) => {
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
          // A new project invalidates any in-progress labeling mode: the pass
          // work list references the OLD project's instances, so leaving it
          // active would mutate the wrong data on the next click.
          state.labelingMode = "select";
          state.seedCentroidAnnotation = false;
          state.passCursor = null;
          state.passWorkList = [];
          state.passDims = null;
          state.passNodeIndices = [];
          // setLabels sets video/frame directly (not via setVideo), so drop any
          // stale identity-keyed transients from the previous project.
          clearTransientVisibility(state);
        });
        // Adopt (or clear) the active-learning workflow saved in this project's
        // provenance. Done after the appStore update, outside the immer producer,
        // since it drives a separate store. Covers every load path + New Project.
        hydrateActiveLearningStore(labels);
      },

      setVideo: (video) =>
        set((state) => {
          if (video !== state.video) {
            // Per-instance visibility is scoped to the current frame/video —
            // reset it whenever the video actually changes.
            clearTransientVisibility(state);
          }
          state.video = video;
          state.frameIdx = 0;
          state.instance = null;
          state.labeledFrame = null;
        }),

      markVideoUpdated: () =>
        set((state) => {
          state.videoRevision += 1;
        }),

      setFrameIdx: (idx) =>
        set((state) => {
          const video = state.video;
          let next: number;
          if (video && video.shape) {
            const maxFrame = (video.shape[0] ?? 1) - 1;
            next = Math.max(0, Math.min(idx, maxFrame));
          } else {
            // No shape info — allow any non-negative index
            next = Math.max(0, idx);
          }
          if (next !== state.frameIdx) {
            // Per-instance visibility is scoped to the current frame — reset it
            // whenever the frame actually changes (SLEAP QC-panel parity). Guard
            // on the clamped target so an out-of-range idx at the boundary is a
            // no-op rather than a spurious clear.
            clearTransientVisibility(state);
          }
          state.frameIdx = next;
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
        const { video, frameIdx, navigationDomain, labels } = get();
        if (!video) return;

        // Confined navigation (#137): in "labeled"/"imaged" mode, step within
        // that domain so arrow keys, prev/next, and playback skip the dead gaps.
        // A null domain ("all", or "imaged" on a full video) or an empty/
        // exhausted one falls through to dense stepping so we never trap.
        const domain = navigableDomain(labels, video, navigationDomain);
        if (domain && domain.length > 0) {
          const target = stepLabeled(domain, frameIdx, step);
          if (target !== null) {
            get().setFrameIdx(target);
            return;
          }
        }

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

      setNavigationDomain: (mode) =>
        set((state) => {
          state.navigationDomain = mode;
        }),

      cycleNavigationDomain: () =>
        set((state) => {
          const order: NavigationDomain[] = ["all", "labeled", "imaged"];
          const i = order.indexOf(state.navigationDomain);
          state.navigationDomain = order[(i + 1) % order.length];
        }),

      setInstanceHidden: (instance, hidden) =>
        set((state) => {
          if (hidden) state.hiddenInstances.add(instance);
          else state.hiddenInstances.delete(instance);
          state.viewOnlyInstance = null; // clicking any Visibility box exits view-only
        }),

      setViewOnlyInstance: (instance) =>
        set((state) => {
          state.viewOnlyInstance = instance;
        }),

      setInstanceInvisibleOverride: (instance, value) =>
        set((state) => {
          if (value === undefined) state.showNonVisibleOverride.delete(instance);
          else state.showNonVisibleOverride.set(instance, value);
        }),

      setQcDisplayMode: (mode) =>
        set((state) => {
          state.qcDisplayMode = mode;
        }),

      resetInstanceVisibility: () =>
        set((state) => {
          clearTransientVisibility(state);
        }),

      setInstance: (instance) =>
        set((state) => {
          state.instance = instance;
        }),

      setLabeledFrame: (frame) =>
        set((state) => {
          state.labeledFrame = frame;
        }),

      // Reset the main video canvas view to its default (zoom = 1, no pan,
      // fit-frame). One-shot: bump a nonce that VideoPlayer subscribes to.
      resetView: () =>
        set((state) => {
          state.resetViewNonce += 1;
        }),

      markChanged: () =>
        set((state) => {
          state.hasChanges = true;
          state.lastInteractedFrame = state.frameIdx;
        }),

      touchFrame: () =>
        set((state) => {
          if (!state.video || !state.labels) return;
          const vidIdx = state.labels.videos.indexOf(state.video);
          const key = `${vidIdx}:${state.frameIdx}`;
          const idx = state.frameInteractionStack.indexOf(key);
          if (idx !== -1) state.frameInteractionStack.splice(idx, 1);
          state.frameInteractionStack.push(key);
        }),

      clearChanges: () =>
        set((state) => {
          state.hasChanges = false;
        }),

      setLoading: (loading, message, progress) =>
        set((state) => {
          state.isLoading = loading;
          state.loadingMessage = message ?? "";
          // Determinate progress: update only when a value is supplied, so
          // messages without a percent (e.g. "Locating videos…") hold the bar
          // rather than snapping it to 0. Reset once the overlay is dismissed.
          if (progress !== undefined) state.loadingProgress = progress;
          if (!loading) state.loadingProgress = 0;
        }),

      setInferenceDialogOpen: (open) =>
        set((state) => {
          state.inferenceDialogOpen = open;
        }),

      setNewProjectDialogOpen: (open) =>
        set((state) => {
          state.newProjectDialogOpen = open;
        }),

      setGoToFrameDialogOpen: (open) =>
        set((state) => {
          state.goToFrameDialogOpen = open;
        }),

      setSelectToFrameDialogOpen: (open) =>
        set((state) => {
          state.selectToFrameDialogOpen = open;
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

      enterSeedMode: (nodeIdx?: number, centroidAnnotation?: boolean) =>
        set((state) => {
          state.labelingMode = "seed";
          if (typeof nodeIdx === "number") state.seedNodeIdx = nodeIdx;
          state.seedCentroidAnnotation = centroidAnnotation ?? false;
        }),

      exitSeedMode: () =>
        set((state) => {
          state.labelingMode = "select";
          state.seedCentroidAnnotation = false;
        }),

      enterKeypointPassMode: ({ workList, dims, nodeIndices, zoomWindow }) => {
        const cur = initialPassCursor(dims);
        set((state) => {
          state.labelingMode = "keypointPass";
          state.passWorkList = workList;
          state.passDims = dims;
          state.passNodeIndices = nodeIndices;
          state.passCursor = cur;
          if (typeof zoomWindow === "number" && zoomWindow > 0) {
            state.passZoomWindow = zoomWindow;
          }
        });
        // Frame the first item. Guard on a non-null cursor: an empty sweep
        // leaves the mode active but with nothing selected.
        if (cur) get().syncPassSelection();
      },

      exitKeypointPassMode: () =>
        set((state) => {
          state.labelingMode = "select";
          state.passCursor = null;
          state.passWorkList = [];
          state.passDims = null;
          state.passNodeIndices = [];
        }),

      passAdvance: () => {
        const { passCursor, passDims } = get();
        if (!passCursor || !passDims) return;
        const next = advancePassCursor(passCursor, passDims);
        const prevItem = passCursor.itemIdx;
        set((state) => {
          state.passCursor = next;
        });
        // next === null → sweep complete; mode stays so the panel/HUD can show
        // the "done" state and VideoPlayer stops re-zooming. Only re-navigate
        // when the work item actually changes (advancing within an item must
        // not deselect the in-progress instance).
        if (next && next.itemIdx !== prevItem) get().syncPassSelection();
      },

      passStepBack: () => {
        const { passCursor, passDims } = get();
        if (!passDims) return;
        // From the completed (null) state, step back INTO the last position.
        const prev = passCursor
          ? stepBackPassCursor(passCursor, passDims)
          : finalPassCursor(passDims);
        if (!prev) return;
        const prevItem = passCursor ? passCursor.itemIdx : -1;
        set((state) => {
          state.passCursor = prev;
        });
        if (prev.itemIdx !== prevItem) get().syncPassSelection();
      },

      passJumpToUnlabeled: () => {
        const s = get();
        if (!s.labels || !s.passDims || s.passWorkList.length === 0) return false;
        const cur = nextUnlabeledCursor(
          s.labels,
          s.passWorkList,
          s.passDims,
          s.passNodeIndices,
          null,
        );
        set((state) => {
          state.passCursor = cur;
        });
        if (cur) get().syncPassSelection();
        return !!cur;
      },

      setPassZoomWindow: (px) =>
        set((state) => {
          state.passZoomWindow = Math.max(16, px);
        }),

      syncPassSelection: () => {
        const s = get();
        const cur = s.passCursor;
        if (!cur || !s.labels) return;
        const item = s.passWorkList[cur.itemIdx];
        if (!item) return;
        const video = s.labels.videos[item.videoIdx];
        if (video && video !== s.video) get().setVideo(video);
        get().setFrameIdx(item.frameIdx);
        get().setInstance(resolveItemInstance(s.labels, item));
      },

      // Toggle a sidebar panel's visibility (#135). Hiding the currently-active
      // panel auto-switches the active panel to the next visible one; hiding the
      // last visible panel is allowed (the strip goes empty, recoverable from the
      // Panels menu).
      togglePanelVisibility: (panelId) =>
        set((state) => {
          const hidden = new Set(state.hiddenPanels);
          if (hidden.has(panelId)) {
            hidden.delete(panelId);
          } else {
            hidden.add(panelId);
            if (state.sidebarActivePanel === panelId) {
              const next = nextVisiblePanel(
                state.panelOrder,
                [...hidden],
                panelId,
              );
              if (next) state.sidebarActivePanel = next;
            }
          }
          state.hiddenPanels = [...hidden];
        }),

      // Restore the default panel order and visibility ("Reset to defaults", #135).
      resetPanels: () =>
        set((state) => {
          state.panelOrder = [...DEFAULT_PANEL_ORDER];
          state.hiddenPanels = [];
          // hidden is now empty, so any known active panel is visible again;
          // only normalize an active id that no longer exists.
          if (
            !(DEFAULT_PANEL_ORDER as readonly string[]).includes(
              state.sidebarActivePanel,
            )
          ) {
            state.sidebarActivePanel = DEFAULT_PANEL_ORDER[0];
          }
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
      // Default zustand merge is shallow, which replaces the persisted panel
      // arrays wholesale — so an order/visibility blob from an older build would
      // silently drop panels added since. Reconcile those two arrays against the
      // current panel set; everything else keeps the shallow-merge behavior.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState> & {
          navigateLabeledOnly?: boolean;
        };
        const merged = {
          ...current,
          ...p,
          // Migrate the pre-tri-state #137 boolean to the navigationDomain enum.
          navigationDomain: navigationDomainFromPersisted(p),
          panelOrder: reconcilePanelOrder(p.panelOrder),
          hiddenPanels: reconcileHiddenPanels(p.hiddenPanels),
        };
        delete (merged as { navigateLabeledOnly?: boolean }).navigateLabeledOnly;
        return merged;
      },
    },
    )
  )
);
