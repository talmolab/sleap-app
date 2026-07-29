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
import type { CropRect } from "@/lib/imageFeaturesCore";
import {
  mergeVideoPrefixSwap,
  type VideoPrefixSwap,
} from "@/lib/videoPrefixSwaps";
import {
  navigableDomain,
  stepLabeled,
  type NavigationDomain,
} from "@/lib/navigableFrames";
export type { NavigationDomain };
import {
  DEFAULT_PANEL_ORDER,
  DEFAULT_OPEN_PANELS,
  reconcilePanelOrder,
  reconcileHiddenPanels,
  reconcileOpenPanels,
  migrateOpenPanels,
  toggleId,
} from "@/lib/panelLayout";

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
  /**
   * The browser File the current project was opened from (file picker), retained
   * so a re-save/export can read its images back via the OPFS streaming writer
   * (WORKERFS source). A snapshot — prefer `projectFileHandle` for writing. Null
   * on Tauri / new projects. NOT persisted (a File cannot be serialized).
   */
  projectFile: File | null;
  /**
   * The durable `FileSystemFileHandle` from a browser file-picker open, when
   * available. PREFERRED over `projectFile`: `getFile()` re-reads fresh bytes,
   * and it lets a plain Save write BACK to the opened file in place (no Save-As
   * dialog, matching a native/PyQt save) as well as a large-pkg re-save/export
   * re-read the source. Null for drag-drop / `<input>` opens and outside Chromium.
   */
  projectFileHandle: FileSystemFileHandle | null;
  hasChanges: boolean;
  /**
   * Monotonic edit counter — bumped on EVERY label edit (markChanged), even when
   * `hasChanges` is already true. The draft auto-save subscribes to this (not the
   * boolean `hasChanges`, which only transitions once) so each edit re-arms the
   * debounce, and so an edit landing mid-save is detected and not dropped.
   */
  editSeq: number;
  /**
   * OPFS path of the browser large-pkg fast-save's labels DRAFT (a bare-bones
   * imageless .slp), or null. Set once a large embedded pkg has been ⌘S/auto-
   * saved this session; the labels live here durably while the images stay in
   * the original. Reset on project load. NOT persisted (resume-on-open, a later
   * piece, will re-discover it via a manifest).
   */
  labelsDraftPath: string | null;
  /**
   * True when there are label edits saved to the local draft but NOT yet
   * compiled/exported to the user's disk file (⌘S / auto-save sets it; an
   * explicit Export clears it). Drives the "saved locally — export to disk"
   * status + the unsaved-work guards.
   */
  pendingExport: boolean;
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
  /**
   * Panels currently OPEN in the sidebar stack (a subset of `panelOrder`),
   * rendered as collapsible sections top-to-bottom in panelOrder. Replaces the
   * old single `sidebarActivePanel` so several panels can stay open at once.
   * Persisted.
   */
  sidebarOpenPanels: string[];
  /**
   * Open panels whose body is collapsed to a header-only strip. A subset of
   * `sidebarOpenPanels`. Persisted.
   */
  sidebarCollapsedSections: string[];
  /**
   * When true, clicking a rail icon opens panels ADDITIVELY (multiple stacked
   * sections). When false (default), the sidebar behaves one-at-a-time: a rail
   * click shows exactly that panel. Toggled from View > Allow multiple panels.
   * Persisted.
   */
  sidebarMultiPanel: boolean;
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

  // === Image-features suggestions ROI (transient; session-only, NOT persisted) ===
  /**
   * Per-video crop region (source-frame pixels) used by the image-features
   * suggestion method to focus clustering on a field-of-view. Session-only,
   * like every other suggestion-generation parameter.
   */
  imageFeatureRois: Map<Video, CropRect>;
  /** True while the canvas is in ROI-draw mode (drag to set the region). */
  imageFeatureRoiDrawActive: boolean;
  /** Set (or clear, when `rect` is null) the current video's image-features ROI. */
  setImageFeatureRoi: (video: Video, rect: CropRect | null) => void;
  /** Toggle canvas ROI-draw mode. */
  setImageFeatureRoiDrawActive: (active: boolean) => void;

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

  // === Video path resolution (persisted preference) ===
  /**
   * Remembered video path prefix swaps (e.g. /root/vast → /Volumes/talmo),
   * learned when the user locates a missing video and reapplied on future opens
   * so projects from the same relocated root auto-resolve without re-locating.
   * Persisted; a deliberate superset of PyQt (see @/lib/videoPrefixSwaps). Read
   * via getState() — don't subscribe with a selector.
   */
  videoPrefixSwaps: VideoPrefixSwap[];

  // === Labeling mode state (transient, not persisted) ===
  labelingMode: "select" | "place";
  placementNodeIdx: number | null;

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
  setLabels: (
    labels: Labels,
    filename?: string,
    projectPath?: string,
    projectFile?: File | null,
    projectFileHandle?: FileSystemFileHandle | null
  ) => void;
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
  /** Remember a learned video path prefix swap (deduped, newest-first, capped). */
  addVideoPrefixSwap: (swap: VideoPrefixSwap) => void;
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
  togglePanelVisibility: (panelId: string) => void;
  resetPanels: () => void;
  /** Rail click: uncollapse the column and open `panelId` if it's collapsed;
   *  otherwise toggle `panelId` in/out of the open stack. */
  togglePanelOpen: (panelId: string) => void;
  /** Ensure `panelId` is open + expanded and the column uncollapsed (used by
   *  menus that jump to a specific panel, e.g. Training/Inference). */
  openPanel: (panelId: string) => void;
  /** Close a section (✕): remove it from the open stack. */
  closePanel: (panelId: string) => void;
  /** Toggle a section's body between expanded and header-only (chevron). */
  toggleSectionCollapsed: (panelId: string) => void;
  /** Enable/disable multi-panel mode; disabling trims the stack to one panel. */
  setSidebarMultiPanel: (enabled: boolean) => void;
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
  "trailLength",
  "insetSize",
  "insetZoom",
  "defaultToPan",
  "seekbarHeaderGraph",
  "seekbarHeaderReduction",
  "navigationDomain",
  "qcDisplayMode",
  "videoPrefixSwaps",
  // Layout + scale persistence (PyQt saveState/restoreState parity).
  "panelOrder",
  "hiddenPanels",
  "sidebarCollapsed",
  "sidebarSide",
  "sidebarOpenPanels",
  "sidebarCollapsedSections",
  "sidebarMultiPanel",
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
      projectFile: null,
      projectFileHandle: null,
      hasChanges: false,
      editSeq: 0,
      labelsDraftPath: null,
      pendingExport: false,
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
      sidebarOpenPanels: [...DEFAULT_OPEN_PANELS],
      sidebarCollapsedSections: [],
      sidebarMultiPanel: false,
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

      // Video path resolution (persisted preference)
      videoPrefixSwaps: [] as VideoPrefixSwap[],

      // Labeling mode state (transient)
      labelingMode: "select" as "select" | "place",
      placementNodeIdx: null as number | null,

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
      setLabels: (labels, filename, projectPath, projectFile, projectFileHandle) =>
        set((state) => {
          state.labels = labels;
          state.filename = filename ?? null;
          state.projectPath = projectPath ?? null;
          state.projectFile = projectFile ?? null;
          state.projectFileHandle = projectFileHandle ?? null;
          state.projectLoaded = true;
          state.hasChanges = false;
          // A newly-loaded project has no labels draft yet (and no stale one
          // from a previous project) — the first large-pkg ⌘S writes one.
          state.labelsDraftPath = null;
          state.pendingExport = false;

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
          // setLabels sets video/frame directly (not via setVideo), so drop any
          // stale identity-keyed transients from the previous project.
          clearTransientVisibility(state);
        }),

      setVideo: (video) =>
        set((state) => {
          if (video !== state.video) {
            // Per-instance visibility is scoped to the current frame/video —
            // reset it whenever the video actually changes.
            clearTransientVisibility(state);
          }
          state.video = video;
          // Mirror legacy SLEAP's switch_frame(video): jump to the video's
          // last labeled frame rather than hardcoding frame 0. Many pkg.slp
          // videos only embed specific labeled source frames (not a
          // contiguous range from 0) — landing on an unembedded frame 0
          // makes getFrame() return null and silently leaves the PREVIOUS
          // video's frame on screen (looks like the click did nothing).
          let targetFrameIdx = 0;
          const frames = state.labels?.labeledFrames;
          if (frames) {
            for (let i = frames.length - 1; i >= 0; i--) {
              if (frames[i].video === video) {
                targetFrameIdx = frames[i].frameIdx;
                break;
              }
            }
          }
          state.frameIdx = targetFrameIdx;
          state.instance = null;
          state.labeledFrame = null;
        }),

      imageFeatureRois: new Map(),
      imageFeatureRoiDrawActive: false,
      setImageFeatureRoi: (video, rect) =>
        set((state) => {
          // Draft Video/Map types are structurally identical to the runtime ones.
          const rois = state.imageFeatureRois as Map<Video, CropRect>;
          if (rect) rois.set(video, rect);
          else rois.delete(video);
        }),
      setImageFeatureRoiDrawActive: (active) =>
        set((state) => {
          state.imageFeatureRoiDrawActive = active;
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

      addVideoPrefixSwap: (swap) => {
        // Compute from the finalized array (not the immer draft) so the pure
        // merge helper sees plain objects, then reassign.
        const next = mergeVideoPrefixSwap(get().videoPrefixSwaps, swap);
        set((state) => {
          state.videoPrefixSwaps = next;
        });
      },

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
          state.editSeq += 1;
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
            // Hiding a panel removes it from the rail entirely, so it can't stay
            // open in the stack — close its section (and any collapsed marker).
            state.sidebarOpenPanels = state.sidebarOpenPanels.filter(
              (id) => id !== panelId,
            );
            state.sidebarCollapsedSections =
              state.sidebarCollapsedSections.filter((id) => id !== panelId);
          }
          state.hiddenPanels = [...hidden];
        }),

      // Restore the default panel order and visibility ("Reset to defaults", #135).
      resetPanels: () =>
        set((state) => {
          state.panelOrder = [...DEFAULT_PANEL_ORDER];
          state.hiddenPanels = [];
          state.sidebarOpenPanels = [...DEFAULT_OPEN_PANELS];
          state.sidebarCollapsedSections = [];
        }),

      // Rail click: reveal a collapsed column (opening the clicked panel too),
      // otherwise toggle the clicked panel in/out of the open stack.
      togglePanelOpen: (panelId) =>
        set((state) => {
          // Single-panel mode (default): classic one-at-a-time rail. A click
          // shows exactly that panel; clicking the sole open panel hides the
          // column.
          if (!state.sidebarMultiPanel) {
            const soleOpen =
              state.sidebarOpenPanels.length === 1 &&
              state.sidebarOpenPanels[0] === panelId;
            if (!state.sidebarCollapsed && soleOpen) {
              state.sidebarCollapsed = true;
            } else {
              state.sidebarCollapsed = false;
              state.sidebarOpenPanels = [panelId];
              state.sidebarCollapsedSections = [];
            }
            return;
          }
          // Multi-panel mode: stack toggle.
          if (state.sidebarCollapsed) {
            state.sidebarCollapsed = false;
            if (!state.sidebarOpenPanels.includes(panelId)) {
              state.sidebarOpenPanels = [...state.sidebarOpenPanels, panelId];
            }
            return;
          }
          const wasOpen = state.sidebarOpenPanels.includes(panelId);
          state.sidebarOpenPanels = toggleId(state.sidebarOpenPanels, panelId);
          if (wasOpen) {
            // Closing: drop any collapsed marker so a re-open starts expanded.
            state.sidebarCollapsedSections =
              state.sidebarCollapsedSections.filter((id) => id !== panelId);
          }
        }),

      // Programmatically open + expand a panel and reveal the column. In single
      // mode this shows exactly that panel; in multi mode it's added to the stack.
      openPanel: (panelId) =>
        set((state) => {
          state.sidebarCollapsed = false;
          if (!state.sidebarMultiPanel) {
            state.sidebarOpenPanels = [panelId];
            state.sidebarCollapsedSections = [];
            return;
          }
          if (!state.sidebarOpenPanels.includes(panelId)) {
            state.sidebarOpenPanels = [...state.sidebarOpenPanels, panelId];
          }
          state.sidebarCollapsedSections =
            state.sidebarCollapsedSections.filter((id) => id !== panelId);
        }),

      closePanel: (panelId) =>
        set((state) => {
          state.sidebarOpenPanels = state.sidebarOpenPanels.filter(
            (id) => id !== panelId,
          );
          state.sidebarCollapsedSections =
            state.sidebarCollapsedSections.filter((id) => id !== panelId);
        }),

      toggleSectionCollapsed: (panelId) =>
        set((state) => {
          state.sidebarCollapsedSections = toggleId(
            state.sidebarCollapsedSections,
            panelId,
          );
        }),

      setSidebarMultiPanel: (enabled) =>
        set((state) => {
          state.sidebarMultiPanel = enabled;
          // Collapsing back to one-at-a-time: keep the topmost open panel (first
          // in panelOrder), drop the rest and any stale collapsed markers.
          if (!enabled && state.sidebarOpenPanels.length > 1) {
            const keep = state.panelOrder.find((id) =>
              state.sidebarOpenPanels.includes(id),
            );
            state.sidebarOpenPanels = keep
              ? [keep]
              : state.sidebarOpenPanels.slice(0, 1);
            state.sidebarCollapsedSections =
              state.sidebarCollapsedSections.filter((id) =>
                state.sidebarOpenPanels.includes(id),
              );
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
          // Legacy single-open-panel field, migrated into sidebarOpenPanels.
          sidebarActivePanel?: string;
        };
        const merged = {
          ...current,
          ...p,
          // Migrate the pre-tri-state #137 boolean to the navigationDomain enum.
          navigationDomain: navigationDomainFromPersisted(p),
          panelOrder: reconcilePanelOrder(p.panelOrder),
          hiddenPanels: reconcileHiddenPanels(p.hiddenPanels),
          // Seed the open-panel stack: a stored set wins; a legacy single
          // active panel migrates when no set was stored (see migrateOpenPanels).
          sidebarOpenPanels: migrateOpenPanels(
            p.sidebarOpenPanels,
            p.sidebarActivePanel,
          ),
          sidebarCollapsedSections: reconcileOpenPanels(
            p.sidebarCollapsedSections,
          ),
        };
        delete (merged as { navigateLabeledOnly?: boolean }).navigateLabeledOnly;
        delete (merged as { sidebarActivePanel?: string }).sidebarActivePanel;
        return merged;
      },
    },
    )
  )
);
