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
  Node,
  Edge,
  Track,
  Video,
  EdgeStyle,
  ColorTarget,
  InstancePlacementMethod,
} from "../types";
import type { StatisticGraphType, Reduction } from "@/lib/statisticSeries";
import { SEEKBAR_HEADER_DEFAULT_HEIGHT } from "@/lib/seekbarHeaderHeight";
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
import { buildTutorialSteps, type TutorialStep } from "@/lib/tutorial/steps";

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

/** Which desktop self-update channel to check: full releases only, the
 * newest of {release, pre-release}, or continuous builds off `main`. */
export type UpdateChannel = "stable" | "latest" | "dev";

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
  /** User-bookmarked frame (Mark Frame ⌘M / go-to ⌘⇧M). One per project. */
  markedFrame: { video: Video; frameIdx: number } | null;
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
   * When true (default), clicking a rail icon opens panels ADDITIVELY (multiple
   * stacked sections). When false, the sidebar behaves one-at-a-time: a rail
   * click shows exactly that panel. Toggled from View > Allow multiple panels.
   * Persisted (existing users keep whatever they last had).
   */
  sidebarMultiPanel: boolean;
  panelOrder: string[];
  hiddenPanels: string[];

  // === View state ===
  showInstances: boolean;
  showLabels: boolean;
  showEdges: boolean;
  showNonVisibleNodes: boolean;
  /**
   * Currently-visible portion of the video frame, in frame/scene pixel
   * coordinates: `[x1, y1, x2, y2]`. Kept in sync by VideoPlayer on every
   * zoom/pan/resize/rotate. Null before the canvas has real dimensions.
   * Read by `AddInstance`'s "random" placement so a new instance lands within
   * view (PyQt parity: `QtVideoPlayer.getVisibleRect()`), not just somewhere
   * in the full underlying frame that may be off-screen when zoomed in.
   */
  visibleSceneRect: [number, number, number, number] | null;
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
  /** Append the ` (0.81)` prediction score to on-canvas track labels. Default off (#316). Persisted. */
  showTrackScore: boolean;
  defaultToPan: boolean;
  palette: string;
  distinctlyColor: ColorTarget;
  markerSize: number;
  nodeLabelSize: number;
  insetSize: number;
  insetZoom: number;
  /** Show the zoomed-in magnifier while dragging/placing a node or holding Shift. Persisted. */
  showInset: boolean;
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
  /**
   * Height (px) of the seekbar header graph, user-resizable via the drag handle
   * on its top edge. Persisted; clamped to [MIN, MAX] (see seekbarHeaderHeight).
   */
  seekbarHeaderHeight: number;
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
  /**
   * Reset the image-features ROI tool: exit draw-mode and drop ALL drawn
   * regions. The region is transient (used only while generating), so it is
   * cleared whenever the Image Features method/view is left.
   */
  resetImageFeatureRoi: () => void;

  // Per-instance visibility (transient; reset on frame change; NOT persisted)
  hiddenInstances: Set<Instance>;
  viewOnlyInstance: Instance | null;
  showNonVisibleOverride: Map<Instance, boolean>;
  // Label-QC display mode (persisted app preference)
  qcDisplayMode: QcMode;
  // Desktop self-update channel (persisted app preference)
  updateChannel: UpdateChannel;
  // Whether the user has EVER selected the "latest" channel (persisted,
  // sticky — sees latest's badge even after switching back to "stable").
  // Gates whether latestUpdateAvailable below contributes to the ambient
  // Environment badge: by default the badge only reflects "stable", so a
  // pre-release doesn't nag someone who never asked for anything but stable
  // releases; opting into "latest" once permanently earns it a say too.
  hasOptedIntoLatestChannel: boolean;
  // Whether a newer STABLE / LATEST release exists than the one currently
  // running — each checked once at startup against its own channel
  // regardless of updateChannel above, so a user on any channel (or just
  // behind) still gets nudged. Transient — NOT persisted, re-checked every
  // launch. Drives the blinking Environment badge (AppShell + WelcomeScreen),
  // gated by hasOptedIntoLatestChannel above for the "latest" half.
  stableUpdateAvailable: boolean;
  stableUpdateVersion: string | null;
  latestUpdateAvailable: boolean;
  latestUpdateVersion: string | null;

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

  // === Skeleton-builder state (transient, not persisted) ===
  // Visual skeleton builder: place nodes on the canvas, then connect them into
  // edges. This is a pure scratch buffer -- the clicked node POSITIONS live
  // only here (never inserted into labels.labeledFrames), so no phantom labeled
  // instance is ever saved. The skeleton graph itself is persisted separately
  // via the existing skeleton commands. `builderPositions` is index-aligned to
  // `skeleton.nodes` and holds scene/source-coord positions (null = unplaced).
  skeletonBuildMode: boolean;
  skeletonBuildStage: "place" | "connect";
  builderPositions: ({ x: number; y: number } | null)[];
  /**
   * The skeleton's nodes/edges as they were when `enterSkeletonBuild` was
   * called — lets an unplanned exit (e.g. switching away from the Skeleton
   * panel mid-draw) offer to revert, without relying on the undo stack
   * (which may have other, unrelated commands interleaved). `null` outside
   * an active build session with unresolved unfinished-work state.
   */
  skeletonBuildEntrySnapshot: { nodes: Node[]; edges: Edge[] } | null;
  /**
   * Non-null → show the "keep or discard?" dialog for an unplanned exit that
   * left unfinished work (nodes/edges added since `skeletonBuildEntrySnapshot`
   * was taken). The value is what "Discard" reverts the skeleton to. Escape
   * and "Done" exits never set this — they're deliberate, so they stay quiet.
   */
  skeletonExitPrompt: { nodes: Node[]; edges: Edge[] } | null;

  // Top-down anchor-part picker (Training panel): click a node on the canvas
  // instead of typing its name. `pickRequestId` disambiguates which requester
  // a result belongs to when more than one head-config field could ask for a
  // pick (e.g. switching tabs mid-pick) — a requester only applies a result
  // whose id matches the one `startAnchorPick` returned it.
  pickingAnchor: boolean;
  pickRequestId: number;
  pickedAnchorNode: { nodeName: string; requestId: number } | null;
  /**
   * Persistent (not just hover-during-pick) crop preview for the currently
   * configured anchor — toggled from the Training panel to check "what would
   * this crop look like" without re-entering pick mode. `anchorPreviewNode`
   * is `null` while inactive; once active, `null` means "Auto" (bbox center)
   * and a string names the anchor node to preview.
   */
  anchorPreviewActive: boolean;
  anchorPreviewNode: string | null;
  /**
   * Session-only "template layout": a snapshot of the node positions the user
   * DREW in the visual skeleton builder (IMAGE space, index-aligned to
   * `skeleton.nodes`), captured on the builder's Done. When set, the
   * center-based Add Instance placement methods (best / template /
   * force_directed) seed their geometry from this drawn layout instead of the
   * scrambled circle. Transient like the other build-mode fields (NOT in
   * PERSISTED_KEYS) — a fresh session starts back on the circle default.
   */
  skeletonTemplateLayout: ({ x: number; y: number } | null)[] | null;

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
  mergeProjectDialogOpen: boolean;
  addVideoUrlDialogOpen: boolean;
  exportDialogOpen: boolean;
  exportClipDialogOpen: boolean;
  modelMetricsDialogOpen: boolean;
  exportPackageDialogOpen: boolean;
  shortcutsDialogOpen: boolean;
  helpDialogOpen: boolean;
  menuSearchDialogOpen: boolean;
  diagnosticsDialogOpen: boolean;
  quitConfirmOpen: boolean;

  // === Getting-started tutorial (transient, not persisted) ===
  tutorialActive: boolean;
  tutorialStepIndex: number;
  /**
   * Resolved once in `startTutorial` (see `buildTutorialSteps`) — whether a
   * project was already loaded at that moment decides the whole sequence, so
   * this isn't re-derived mid-run.
   */
  tutorialSteps: TutorialStep[];
  /**
   * Furthest `tutorialStepIndex` reached so far this run (only advanced by
   * `advanceTutorialStep`, never by `previousTutorialStep`). Lets
   * `TutorialOverlay` tell "stepped back to re-read a step already cleared"
   * apart from "still working on the current frontier step" — a step below
   * this mark doesn't need its real-world action redone to move forward again.
   */
  tutorialHighestStepIndex: number;

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
  setUpdateChannel: (channel: UpdateChannel) => void;
  setStableUpdateInfo: (available: boolean, version: string | null) => void;
  setLatestUpdateInfo: (available: boolean, version: string | null) => void;
  /** Remember a learned video path prefix swap (deduped, newest-first, capped). */
  addVideoPrefixSwap: (swap: VideoPrefixSwap) => void;
  resetInstanceVisibility: () => void;
  setInstance: (instance: Instance | null) => void;
  setLabeledFrame: (frame: LabeledFrame | null) => void;
  setMarkedFrame: (marked: { video: Video; frameIdx: number } | null) => void;
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
  setMergeProjectDialogOpen: (open: boolean) => void;
  setAddVideoUrlDialogOpen: (open: boolean) => void;
  setExportDialogOpen: (open: boolean) => void;
  setExportClipDialogOpen: (open: boolean) => void;
  setModelMetricsDialogOpen: (open: boolean) => void;
  setExportPackageDialogOpen: (open: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setHelpDialogOpen: (open: boolean) => void;
  setDiagnosticsDialogOpen: (open: boolean) => void;
  setMenuSearchDialogOpen: (open: boolean) => void;
  /** Start the getting-started tutorial from its first step. */
  startTutorial: () => void;
  /** Stop the tutorial at any point (Exit button). */
  exitTutorial: () => void;
  /** Advance to the next tutorial step, or exit once past the last one. */
  advanceTutorialStep: () => void;
  /** Go back to the previous tutorial step; a no-op on the first step. */
  previousTutorialStep: () => void;
  enterPlacementMode: () => void;
  exitPlacementMode: () => void;

  // Skeleton-builder actions (scratch buffer; see field docs above).
  enterSkeletonBuild: () => void;
  /**
   * `promptIfUnfinished`: when true and the skeleton's nodes/edges changed
   * since `enterSkeletonBuild`, sets `skeletonExitPrompt` instead of quietly
   * discarding that info — for an unplanned exit (e.g. leaving the Skeleton
   * panel) where the user hasn't explicitly said "I'm done" or "cancel"
   * (Escape/Done omit this so they stay quiet, as before).
   */
  exitSkeletonBuild: (opts?: { promptIfUnfinished?: boolean }) => void;
  /** Resolve the "keep or discard?" prompt: `keep === false` reverts the
   * skeleton to `skeletonExitPrompt`'s snapshot. Always clears the prompt. */
  resolveSkeletonExitPrompt: (keep: boolean) => void;
  setSkeletonBuildStage: (stage: "place" | "connect") => void;
  setBuilderPosition: (
    nodeIdx: number,
    p: { x: number; y: number } | null
  ) => void;
  syncBuilderPositions: () => void;
  /**
   * Snapshot the current `builderPositions` into `skeletonTemplateLayout` (a
   * distinct array copy). Empty positions → `null`. Called on the builder's
   * Done so the drawn layout becomes the session seed for Add Instance.
   */
  captureSkeletonTemplateLayout: () => void;
  /** Discard the captured template layout (back to the circle default). */
  clearSkeletonTemplateLayout: () => void;

  // Anchor-part picker actions (see field docs above). `startAnchorPick`
  // returns the new request id so the requester can match it against
  // `pickedAnchorNode` later without racing a different requester's pick.
  startAnchorPick: () => number;
  cancelAnchorPick: () => void;
  resolveAnchorPick: (nodeName: string) => void;
  clearPickedAnchorNode: () => void;
  /** Show/update the persistent anchor crop preview (see field docs above). */
  setAnchorPreview: (nodeName: string | null) => void;
  /** Hide the persistent anchor crop preview. */
  clearAnchorPreview: () => void;
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
  "showTrackScore",
  "trailLength",
  "insetSize",
  "insetZoom",
  "showInset",
  "defaultToPan",
  "seekbarHeaderGraph",
  "seekbarHeaderReduction",
  "seekbarHeaderHeight",
  "navigationDomain",
  "qcDisplayMode",
  "updateChannel",
  "hasOptedIntoLatestChannel",
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
      markedFrame: null,
      frameInteractionStack: [],

      // UI layout state
      uiScale: 1,
      sidebarCollapsed: false,
      sidebarSide: "right",
      sidebarOpenPanels: [...DEFAULT_OPEN_PANELS],
      sidebarCollapsedSections: [],
      sidebarMultiPanel: true,
      panelOrder: [...DEFAULT_PANEL_ORDER],
      hiddenPanels: [],

      // View state
      showInstances: true,
      showLabels: true,
      showEdges: true,
      showNonVisibleNodes: true,
      visibleSceneRect: null,
      showCrosshair: false,
      edgeStyle: "Line" as EdgeStyle,
      fit: false,
      fitSelection: false,
      resetViewNonce: 0,
      colorPredicted: false,
      showTrackScore: false,
      defaultToPan: false,
      palette: "standard",
      distinctlyColor: "auto" as ColorTarget,
      markerSize: 4,
      nodeLabelSize: 12,
      insetSize: 400,
      insetZoom: 2,
      showInset: true,
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
      seekbarHeaderHeight: SEEKBAR_HEADER_DEFAULT_HEIGHT,
      navigationDomain: "all" as NavigationDomain,

      // Per-instance visibility (transient) + QC display mode (persisted)
      hiddenInstances: new Set<Instance>(),
      viewOnlyInstance: null,
      showNonVisibleOverride: new Map<Instance, boolean>(),
      qcDisplayMode: "manual",
      updateChannel: "stable",
      hasOptedIntoLatestChannel: false,
      stableUpdateAvailable: false,
      stableUpdateVersion: null,
      latestUpdateAvailable: false,
      latestUpdateVersion: null,

      // Editing state
      instanceInitMethod: "best" as InstancePlacementMethod,
      clipboardTrack: null,
      clipboardInstance: null,

      // Video path resolution (persisted preference)
      videoPrefixSwaps: [] as VideoPrefixSwap[],

      // Labeling mode state (transient)
      labelingMode: "select" as "select" | "place",
      placementNodeIdx: null as number | null,

      // Skeleton-builder state (transient scratch buffer)
      skeletonBuildMode: false,
      skeletonBuildStage: "place" as "place" | "connect",
      builderPositions: [] as ({ x: number; y: number } | null)[],
      skeletonBuildEntrySnapshot: null as { nodes: Node[]; edges: Edge[] } | null,
      skeletonExitPrompt: null as { nodes: Node[]; edges: Edge[] } | null,
      skeletonTemplateLayout: null as ({ x: number; y: number } | null)[] | null,

      // Anchor-part picker (transient)
      pickingAnchor: false,
      pickRequestId: 0,
      pickedAnchorNode: null as { nodeName: string; requestId: number } | null,
      anchorPreviewActive: false,
      anchorPreviewNode: null as string | null,

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
      mergeProjectDialogOpen: false,
      addVideoUrlDialogOpen: false,
      exportDialogOpen: false,
      exportClipDialogOpen: false,
      modelMetricsDialogOpen: false,
      exportPackageDialogOpen: false,
      shortcutsDialogOpen: false,
      helpDialogOpen: false,
      menuSearchDialogOpen: false,
      diagnosticsDialogOpen: false,
      quitConfirmOpen: false,

      tutorialActive: false,
      tutorialStepIndex: 0,
      tutorialSteps: [],
      tutorialHighestStepIndex: 0,

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
      resetImageFeatureRoi: () =>
        set((state) => {
          state.imageFeatureRoiDrawActive = false;
          state.imageFeatureRois = new Map();
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

      setUpdateChannel: (channel) =>
        set((state) => {
          state.updateChannel = channel;
          // Sticky: once earned, "latest" keeps a say in the ambient badge
          // even if the user later switches back to "stable" — never unset.
          if (channel === "latest") state.hasOptedIntoLatestChannel = true;
        }),

      setStableUpdateInfo: (available, version) =>
        set((state) => {
          state.stableUpdateAvailable = available;
          state.stableUpdateVersion = version;
        }),

      setLatestUpdateInfo: (available, version) =>
        set((state) => {
          state.latestUpdateAvailable = available;
          state.latestUpdateVersion = version;
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

      setMarkedFrame: (marked) =>
        set((state) => {
          state.markedFrame = marked;
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
      setMergeProjectDialogOpen: (open) =>
        set((state) => {
          state.mergeProjectDialogOpen = open;
        }),

      setAddVideoUrlDialogOpen: (open) =>
        set((state) => {
          state.addVideoUrlDialogOpen = open;
        }),

      setExportDialogOpen: (open) =>
        set((state) => {
          state.exportDialogOpen = open;
        }),

      setExportClipDialogOpen: (open) =>
        set((state) => {
          state.exportClipDialogOpen = open;
        }),

      setModelMetricsDialogOpen: (open) =>
        set((state) => {
          state.modelMetricsDialogOpen = open;
        }),

      setExportPackageDialogOpen: (open) =>
        set((state) => {
          state.exportPackageDialogOpen = open;
        }),

      setShortcutsDialogOpen: (open) =>
        set((state) => {
          state.shortcutsDialogOpen = open;
        }),

      setMenuSearchDialogOpen: (open) =>
        set((state) => {
          state.menuSearchDialogOpen = open;
        }),

      setHelpDialogOpen: (open) =>
        set((state) => {
          state.helpDialogOpen = open;
        }),

      setDiagnosticsDialogOpen: (open) =>
        set((state) => {
          state.diagnosticsDialogOpen = open;
        }),

      startTutorial: () => {
        // Whether a project already exists decides the whole sequence (a
        // fresh app has no Sidebar/panels mounted yet — see AppShell — so it
        // must go through New Project first); resolved once here, not
        // re-derived mid-run.
        const steps = buildTutorialSteps(get().projectLoaded);
        set((state) => {
          state.tutorialActive = true;
          state.tutorialStepIndex = 0;
          state.tutorialSteps = steps;
          state.tutorialHighestStepIndex = 0;
        });
        if (steps[0]?.panelId) get().openPanel(steps[0].panelId);
      },

      exitTutorial: () =>
        set((state) => {
          state.tutorialActive = false;
        }),

      advanceTutorialStep: () => {
        const steps = get().tutorialSteps;
        const nextIndex = get().tutorialStepIndex + 1;
        if (nextIndex >= steps.length) {
          set((state) => {
            state.tutorialActive = false;
          });
          return;
        }
        set((state) => {
          state.tutorialStepIndex = nextIndex;
          state.tutorialHighestStepIndex = Math.max(state.tutorialHighestStepIndex, nextIndex);
        });
        const nextStep = steps[nextIndex];
        if (nextStep?.panelId) get().openPanel(nextStep.panelId);
      },

      previousTutorialStep: () => {
        const prevIndex = get().tutorialStepIndex - 1;
        if (prevIndex < 0) return;
        set((state) => {
          state.tutorialStepIndex = prevIndex;
        });
        const prevStep = get().tutorialSteps[prevIndex];
        if (prevStep?.panelId) get().openPanel(prevStep.panelId);
      },

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

      // Enter the visual skeleton builder. Seeds one null slot per skeleton
      // node (scratch positions, index-aligned). Also clears place-labeling so
      // the two modes never fight over canvas clicks. Snapshots the current
      // nodes/edges so an unplanned exit can offer to revert to them.
      enterSkeletonBuild: () =>
        set((state) => {
          state.skeletonBuildMode = true;
          state.skeletonBuildStage = "place";
          state.builderPositions = state.skeleton
            ? state.skeleton.nodes.map(() => null)
            : [];
          state.labelingMode = "select";
          state.placementNodeIdx = null;
          state.skeletonBuildEntrySnapshot = state.skeleton
            ? { nodes: [...state.skeleton.nodes], edges: [...state.skeleton.edges] }
            : { nodes: [], edges: [] };
        }),

      // Exit the builder and discard the scratch buffer. MUST NOT touch labels
      // or skeleton -- the net-neutral invariant (no phantom labeled instance).
      // `promptIfUnfinished`: for an unplanned exit, ask "keep or discard?"
      // instead of silently leaving whatever was added since entry in place.
      exitSkeletonBuild: (opts) =>
        set((state) => {
          state.skeletonBuildMode = false;
          state.skeletonBuildStage = "place";
          state.builderPositions = [];

          const entry = state.skeletonBuildEntrySnapshot;
          const changedSinceEntry =
            !!entry &&
            !!state.skeleton &&
            (state.skeleton.nodes.length !== entry.nodes.length ||
              state.skeleton.edges.length !== entry.edges.length);

          if (opts?.promptIfUnfinished && changedSinceEntry && entry) {
            state.skeletonExitPrompt = entry;
          }
          state.skeletonBuildEntrySnapshot = null;
        }),

      // Resolve the "keep or discard?" prompt. Discard reverts the skeleton
      // to the pre-build snapshot and marks the project changed (same as any
      // other skeleton edit); keep leaves it exactly as drawn.
      //
      // The skeleton mutation itself happens on the REAL object via `get()`,
      // not inside the `set()` draft below — matching how every other
      // skeleton edit in this app works (CommandContext's `ctx.state` is
      // also plain `useAppStore.getState()`, mutated directly). `Skeleton` is
      // a sleap-io.js class instance, not a plain object/array/Map/Set, so
      // Immer doesn't draft it; mutating it "through" a draft would silently
      // mutate the same live object anyway, so do it explicitly and use
      // `set()` only for the plain fields that Immer actually tracks.
      resolveSkeletonExitPrompt: (keep) => {
        const { skeleton, skeletonExitPrompt: prompt } = get();
        const discarding = !keep && !!prompt && !!skeleton;
        if (discarding) {
          skeleton.nodes = [...prompt.nodes];
          skeleton.edges = [...prompt.edges];
          skeleton.rebuildCache(skeleton.nodes);
        }
        set((state) => {
          if (discarding) {
            state.hasChanges = true;
            state.editSeq += 1;
            state.lastInteractedFrame = state.frameIdx;
            state.overlayVersion += 1;
          }
          state.skeletonExitPrompt = null;
        });
      },

      setSkeletonBuildStage: (stage) =>
        set((state) => {
          state.skeletonBuildStage = stage;
        }),

      // Replace one scratch position immutably (new array so React/Zustand sees
      // the change). Growing past the current length back-fills with nulls.
      setBuilderPosition: (nodeIdx, p) =>
        set((state) => {
          const next = state.builderPositions.slice();
          for (let i = next.length; i < nodeIdx; i++) next[i] = null;
          next[nodeIdx] = p;
          state.builderPositions = next;
        }),

      // Reconcile the scratch buffer length with the current skeleton: append
      // null for newly added nodes, drop extras for removed ones, preserving
      // surviving entries by index.
      syncBuilderPositions: () =>
        set((state) => {
          const n = state.skeleton ? state.skeleton.nodes.length : 0;
          const next = state.builderPositions.slice(0, n);
          for (let i = next.length; i < n; i++) next[i] = null;
          state.builderPositions = next;
        }),

      // Capture the drawn builder layout as a session-only template (a distinct
      // deep copy, so later builder edits don't mutate the snapshot). Empty
      // positions → null. The center-based Add Instance methods seed from this
      // in place of the scrambled circle (see @/lib/instancePlacement).
      captureSkeletonTemplateLayout: () =>
        set((state) => {
          state.skeletonTemplateLayout =
            state.builderPositions.length > 0
              ? state.builderPositions.map((p) => (p ? { x: p.x, y: p.y } : null))
              : null;
        }),

      clearSkeletonTemplateLayout: () =>
        set((state) => {
          state.skeletonTemplateLayout = null;
        }),

      // Anchor-part picker (Training panel). See field docs above for the
      // request-id race-avoidance rationale.
      startAnchorPick: () => {
        const id = get().pickRequestId + 1;
        set((state) => {
          state.pickingAnchor = true;
          state.pickRequestId = id;
          state.pickedAnchorNode = null;
        });
        return id;
      },

      cancelAnchorPick: () =>
        set((state) => {
          state.pickingAnchor = false;
        }),

      resolveAnchorPick: (nodeName) =>
        set((state) => {
          state.pickingAnchor = false;
          state.pickedAnchorNode = { nodeName, requestId: state.pickRequestId };
        }),

      clearPickedAnchorNode: () =>
        set((state) => {
          state.pickedAnchorNode = null;
        }),

      setAnchorPreview: (nodeName) =>
        set((state) => {
          state.anchorPreviewActive = true;
          state.anchorPreviewNode = nodeName;
        }),

      clearAnchorPreview: () =>
        set((state) => {
          state.anchorPreviewActive = false;
          state.anchorPreviewNode = null;
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
          // Multi-panel mode: accordion. A rail click focuses the clicked panel
          // (open + expanded) and minimizes every OTHER open panel to a header
          // strip. Re-clicking the currently-expanded panel collapses it. The
          // per-panel chevron (toggleSectionCollapsed), resize, and close (X)
          // stay independent, so interacting with one open panel never affects
          // its neighbors. Panels are removed from the stack only via closePanel.
          if (state.sidebarCollapsed) {
            state.sidebarCollapsed = false;
            if (!state.sidebarOpenPanels.includes(panelId)) {
              state.sidebarOpenPanels = [...state.sidebarOpenPanels, panelId];
            }
            state.sidebarCollapsedSections = state.sidebarOpenPanels.filter(
              (id) => id !== panelId,
            );
            return;
          }
          const isOpen = state.sidebarOpenPanels.includes(panelId);
          const isExpanded =
            isOpen && !state.sidebarCollapsedSections.includes(panelId);
          if (isExpanded) {
            // Re-click the expanded panel → collapse it to a header strip.
            state.sidebarCollapsedSections = [
              ...state.sidebarCollapsedSections,
              panelId,
            ];
            return;
          }
          // Open (if needed) + expand the clicked panel, minimize the rest.
          if (!isOpen) {
            state.sidebarOpenPanels = [...state.sidebarOpenPanels, panelId];
          }
          state.sidebarCollapsedSections = state.sidebarOpenPanels.filter(
            (id) => id !== panelId,
          );
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
