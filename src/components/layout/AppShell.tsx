/**
 * Main application shell layout.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────┐
 * │ MenuBar                                         │
 * ├──────────────────────┬──────────────┬───────────┤
 * │                      │ Panel Content│ Icon Strip│
 * │  VideoPlayer         │ (expandable) │ (44px)    │
 * │  + Canvas Overlay    │              │           │
 * │  + Seekbar           │              │           │
 * ├──────────────────────┴──────────────┴───────────┤
 * │ StatusBar                                       │
 * └─────────────────────────────────────────────────┘
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PathResolutionDialog } from "../dialogs/PathResolutionDialog";
import type { ResolvedPath } from "@/lib/pathMappings";
import { Toaster } from "sonner";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { VideoPlayer } from "../video/VideoPlayer";

import { PANELS } from "./panelRegistry";
import { reorderById, visibleOpenPanels } from "@/lib/panelLayout";
import { hasUnsavedWork } from "@/lib/unsavedGuard";
import { setupLabelsAutosave } from "@/lib/labelsAutosave";
import { WelcomeScreen } from "./WelcomeScreen";
import { GoToFrameDialog } from "../dialogs/GoToFrameDialog";
import { NewProjectDialog } from "../dialogs/NewProjectDialog";
import { SelectToFrameDialog } from "../dialogs/SelectToFrameDialog";
import { DeletePredictionsDialog } from "../dialogs/DeletePredictionsDialog";
import { ExportDialog } from "../dialogs/ExportDialog";
import { ExportClipDialog } from "../dialogs/ExportClipDialog";
import { ModelMetricsDialog } from "../dialogs/ModelMetricsDialog";
import { ShortcutsDialog } from "../dialogs/ShortcutsDialog";
import { HelpDialog } from "../dialogs/HelpDialog";
import { useAppStore } from "../../stores/appStore";
import { useTrainingStore } from "../../stores/trainingStore";
import {
  PanelRightClose,
  PanelRightOpen,
  PanelLeftClose,
  PanelLeftOpen,
  GripVertical,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  notificationListeners,
  getUnreadCount,
  markAllRead,
} from "../../lib/notificationStore";

/** Hosts the PathResolutionDialog, listening for custom events from stores. */
function PathResolutionHost() {
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    paths: ResolvedPath[];
    resolve: ((result: Array<{ local: string; worker: string }> | null) => void) | null;
  }>({ open: false, paths: [], resolve: null });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setDialogState({
        open: true,
        paths: detail.paths,
        resolve: detail.resolve,
      });
    };
    window.addEventListener("sleap:path-resolution", handler);
    return () => window.removeEventListener("sleap:path-resolution", handler);
  }, []);

  const handleSubmit = useCallback(
    async (resolvedPaths: Array<{ local: string; worker: string }>) => {
      // Detect and save new prefix mappings
      const { detectPrefixDiff, saveMapping } = await import("@/lib/pathMappings");
      const savedPrefixes = new Set<string>();
      for (const { local, worker } of resolvedPaths) {
        const diff = detectPrefixDiff(local, worker);
        if (diff && !savedPrefixes.has(diff.local)) {
          await saveMapping(diff);
          savedPrefixes.add(diff.local);
        }
      }

      dialogState.resolve?.(resolvedPaths);
      setDialogState({ open: false, paths: [], resolve: null });
    },
    [dialogState.resolve],
  );

  const handleCancel = useCallback(() => {
    dialogState.resolve?.(null);
    setDialogState({ open: false, paths: [], resolve: null });
  }, [dialogState.resolve]);

  return (
    <PathResolutionDialog
      open={dialogState.open}
      paths={dialogState.paths}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
}

export function AppShell() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const isLoading = useAppStore((s) => s.isLoading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const loadingProgress = useAppStore((s) => s.loadingProgress);
  const sidebarSide = useAppStore((s) => s.sidebarSide);

  // Dialog state
  const deletePredictionsDialogOpen = useAppStore(
    (s) => s.deletePredictionsDialogOpen
  );
  const setDeletePredictionsDialogOpen = useAppStore(
    (s) => s.setDeletePredictionsDialogOpen
  );
  const exportDialogOpen = useAppStore((s) => s.exportDialogOpen);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const modelMetricsDialogOpen = useAppStore((s) => s.modelMetricsDialogOpen);
  const setModelMetricsDialogOpen = useAppStore(
    (s) => s.setModelMetricsDialogOpen
  );
  const modelOutputDirs = useTrainingStore((s) => s.modelOutputDirs);
  const shortcutsDialogOpen = useAppStore((s) => s.shortcutsDialogOpen);
  const setShortcutsDialogOpen = useAppStore((s) => s.setShortcutsDialogOpen);
  const helpDialogOpen = useAppStore((s) => s.helpDialogOpen);
  const setHelpDialogOpen = useAppStore((s) => s.setHelpDialogOpen);

  // Unsaved changes protection: warn before closing/refreshing when there are
  // in-memory edits (hasChanges) OR a large-pkg labels draft saved locally but
  // not yet exported to disk (pendingExport) — the latter survives in OPFS
  // (resume-on-open can restore it) but the user hasn't written the file to disk
  // yet, so a close still deserves a warning.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedWork(useAppStore.getState())) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Auto-save the labels draft a beat after edits settle (instant, silent) —
  // a crash-recovery net in BOTH runtimes: browser → OPFS, desktop → an
  // app-local disk draft (see labelsAutosave.ts). setupLabelsAutosave gates on
  // eligibility per runtime.
  useEffect(() => setupLabelsAutosave(), []);

  // Drag-and-drop to open a project is intentionally limited to the WelcomeScreen
  // (no project loaded) so a stray drop can never silently replace a project the
  // user is editing. WelcomeScreen owns its own drop handler; on desktop the
  // Tauri drag-drop listener in App.tsx applies the same project-loaded guard.

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <MenuBar />

      <ErrorBoundary>
        <div className="flex-1 flex overflow-hidden relative">
          {projectLoaded ? (
            <div
              className={cn(
                "flex-1 flex min-w-0 h-full",
                // Sidebar on the left → reverse the row so it docks left of the
                // canvas. The Sidebar mirrors its own internals to match.
                sidebarSide === "left" && "flex-row-reverse"
              )}
            >
              {/* Video player takes remaining space */}
              <div className="flex-1 flex flex-col min-w-0 h-full">
                <VideoPlayer />
              </div>

              {/* Sidebar (icon strip + optional expanded panel) */}
              <Sidebar />
            </div>
          ) : (
            <WelcomeScreen />
          )}

          {/* Loading overlay: determinate progress bar + stage message, with a
              forward "pulse" shimmer that signals active work even between
              progress ticks. */}
          {isLoading && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="flex w-72 max-w-[80%] flex-col items-center gap-3">
                <div className="relative w-full">
                  <Progress value={loadingProgress} className="h-2" />
                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
                    <div className="progress-shimmer h-full w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
                  </div>
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  {/* Strip the trailing "(NN%)" — the bar shows the number now. */}
                  {loadingMessage.replace(/\s*\(\d+%\)\s*$/, "") || "Loading..."}
                </p>
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>

      <StatusBar />

      {/* Global dialogs */}
      <NewProjectDialog />
      <GoToFrameDialog />
      <SelectToFrameDialog />
      <DeletePredictionsDialog
        open={deletePredictionsDialogOpen}
        onOpenChange={setDeletePredictionsDialogOpen}
      />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
      <ExportClipDialog />
      <ModelMetricsDialog
        open={modelMetricsDialogOpen}
        onOpenChange={setModelMetricsDialogOpen}
        runDirs={modelOutputDirs}
      />
      <ShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />
      <HelpDialog
        open={helpDialogOpen}
        onOpenChange={setHelpDialogOpen}
      />
      <PathResolutionHost />

      {/* Toast notifications. closeButton renders an always-visible X (see the
          data-[sonner-toast] rules in index.css that keep it and the copy
          button shown, not hover-only). */}
      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        toastOptions={{
          className: "bg-card border-border text-foreground",
        }}
      />
    </div>
  );
}

/** Collapsible sidebar with vertical icon strip + expandable panel content. */
function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const openPanels = useAppStore((s) => s.sidebarOpenPanels);
  const collapsedSections = useAppStore((s) => s.sidebarCollapsedSections);
  const panelOrder = useAppStore((s) => s.panelOrder);
  const hiddenPanels = useAppStore((s) => s.hiddenPanels);
  const sidebarSide = useAppStore((s) => s.sidebarSide);
  const set = useAppStore((s) => s.set);
  const togglePanelOpenAction = useAppStore((s) => s.togglePanelOpen);
  const toggleSectionCollapsed = useAppStore((s) => s.toggleSectionCollapsed);
  const closePanel = useAppStore((s) => s.closePanel);

  // When docked left, the whole sidebar (rail | panel | resize) mirrors so the
  // icon rail sits on the window edge and the resize handle faces the canvas.
  const onLeft = sidebarSide === "left";

  // Sidebar resize state
  const [panelWidth, setPanelWidth] = useState(320);
  // Per-section flex-grow weights for the stacked panels (keyed by panel id).
  // Local + non-persisted, matching panelWidth; a section defaults to weight 1.
  // Dragging a divider between two expanded sections redistributes weight
  // between just that pair, leaving the others untouched.
  const [sectionWeights, setSectionWeights] = useState<Record<string, number>>(
    {},
  );
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Hover-expand: the icon rail widens to reveal panel labels (#135). A 44px
  // in-flow placeholder reserves the footprint; the rail itself is absolutely
  // positioned and grows leftward over the canvas, so it never reflows it.
  const [railExpanded, setRailExpanded] = useState(false);

  // Drag-to-reorder state, tracked by panel id (not render index): once the
  // strip hides panels, a render index no longer maps to a panelOrder index.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Notification unread badge
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const listener = () => setUnreadCount(getUnreadCount());
    notificationListeners.add(listener);
    return () => { notificationListeners.delete(listener); };
  }, []);

  const togglePanel = (panelId: string) => {
    togglePanelOpenAction(panelId);
    // Opening (or interacting with) the notifications panel clears its unread
    // badge, matching the previous single-panel behavior.
    if (panelId === "notifications") markAllRead();
  };

  const toggleCollapse = () => {
    set("sidebarCollapsed", !collapsed);
  };

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      // Drag toward the canvas widens the panel: leftward for a right-docked
      // sidebar, rightward for a left-docked one.
      const delta = onLeft
        ? e.clientX - startX.current
        : startX.current - e.clientX;
      const newWidth = Math.max(220, Math.min(600, startWidth.current + delta));
      setPanelWidth(newWidth);
    };

    const handleUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [panelWidth, onLeft]);

  // Drag the divider between two adjacent expanded sections to adjust their
  // relative heights. Captures the pair's current pixel heights + weights, then
  // moves pixels from one to the other (clamped to a min), converting back to
  // weights via the pair's local density so only these two sections change.
  const handleSectionResizeStart = useCallback(
    (e: React.MouseEvent, aboveId: string, belowId: string) => {
      e.preventDefault();
      const container = e.currentTarget.parentElement;
      if (!container) return;
      const aboveEl = container.querySelector<HTMLElement>(
        `[data-section-id="${aboveId}"]`,
      );
      const belowEl = container.querySelector<HTMLElement>(
        `[data-section-id="${belowId}"]`,
      );
      if (!aboveEl || !belowEl) return;

      const startY = e.clientY;
      const h0Above = aboveEl.offsetHeight;
      const h0Below = belowEl.offsetHeight;
      const sumH = h0Above + h0Below;
      const wAbove0 = sectionWeights[aboveId] ?? 1;
      const wBelow0 = sectionWeights[belowId] ?? 1;
      const density = sumH / (wAbove0 + wBelow0); // px per weight unit
      const MIN = 80; // px — keep a section from collapsing to an unusable sliver

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        const hAbove = Math.max(
          MIN,
          Math.min(sumH - MIN, h0Above + (ev.clientY - startY)),
        );
        const hBelow = sumH - hAbove;
        setSectionWeights((w) => ({
          ...w,
          [aboveId]: hAbove / density,
          [belowId]: hBelow / density,
        }));
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sectionWeights],
  );

  // Pointer-based drag-to-reorder. Native HTML5 DnD proved unreliable here: the
  // app's global file-drop handlers and (in the desktop webview) Tauri's
  // OS-level drag-drop interception fight the dataTransfer effect negotiation,
  // leaving a stuck "copy" cursor and a drop the browser refuses to fire. Mouse
  // events — the same mechanism the resize handle uses — sidestep all of it and
  // work identically in the browser and the Tauri app.
  const reorderDrag = useRef<{ fromId: string; startY: number; dragging: boolean } | null>(null);
  const justDragged = useRef(false);

  const resetDrag = () => {
    setDragId(null);
    setDragOverId(null);
  };

  const panelIdAtPoint = (x: number, y: number): string | undefined =>
    document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-panel-id]")?.dataset.panelId;

  const handleReorderPointerDown = (e: React.MouseEvent, panelId: string) => {
    if (e.button !== 0) return;
    // Clear any stale suppression: a cross-element drag (down on A, up on B)
    // fires no trailing click, so the flag would otherwise linger and swallow
    // the next genuine click. Each fresh mousedown starts clean.
    justDragged.current = false;
    reorderDrag.current = { fromId: panelId, startY: e.clientY, dragging: false };

    const onMove = (ev: MouseEvent) => {
      const st = reorderDrag.current;
      if (!st) return;
      if (!st.dragging) {
        if (Math.abs(ev.clientY - st.startY) < 5) return; // tolerate a click jitter
        st.dragging = true;
        setRailExpanded(true); // keep labels visible through the drag
        setDragId(st.fromId);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      setDragOverId(panelIdAtPoint(ev.clientX, ev.clientY) ?? null);
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const st = reorderDrag.current;
      reorderDrag.current = null;
      if (st?.dragging) {
        justDragged.current = true; // swallow the click that trails this mouseup
        const toId = panelIdAtPoint(ev.clientX, ev.clientY);
        if (toId && toId !== st.fromId) {
          set("panelOrder", reorderById(panelOrder, st.fromId, toId));
        }
      }
      resetDrag();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handlePanelClick = (panelId: string) => {
    if (justDragged.current) {
      justDragged.current = false; // this "click" was the tail of a drag
      return;
    }
    togglePanel(panelId);
  };

  // Visible panels in order (hidden ones filtered out, #135).
  const orderedPanels = panelOrder
    .filter((id) => !hiddenPanels.includes(id))
    .map((id) => PANELS.find((p) => p.id === id))
    .filter(Boolean) as (typeof PANELS)[number][];

  // Panels shown in the stack, in panelOrder: open AND not hidden. The column
  // shows only when at least one such panel exists and the sidebar isn't
  // globally collapsed (hiding every panel, or collapsing, leaves the rail bare).
  const stackPanels = visibleOpenPanels(panelOrder, openPanels, hiddenPanels)
    .map((id) => PANELS.find((p) => p.id === id))
    .filter(Boolean) as (typeof PANELS)[number][];
  const showPanel = !collapsed && stackPanels.length > 0;

  return (
    <div className={cn("flex h-full shrink-0", onLeft && "flex-row-reverse")}>
      {/* Resize handle (only when the column is shown) */}
      {showPanel && (
        <div
          className="w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary bg-border transition-colors"
          onMouseDown={handleResizeStart}
        />
      )}

      {/* Stack of open panels — each a collapsible section. Expanded sections
          share the column height (flex-1); collapsed ones show header only. */}
      {showPanel && (
        <div
          className="h-full bg-card flex flex-col overflow-hidden"
          style={{ width: panelWidth }}
        >
          {stackPanels.map((panel, idx) => {
            const Body = panel.component;
            const sectionCollapsed = collapsedSections.includes(panel.id);
            const prev = stackPanels[idx - 1];
            // A drag handle sits between two DOM-adjacent EXPANDED sections
            // (collapsed sections are fixed header strips — nothing to resize).
            const showSplitter =
              !!prev &&
              !collapsedSections.includes(prev.id) &&
              !sectionCollapsed;
            return (
              <Fragment key={panel.id}>
                {showSplitter && (
                  <div
                    className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-primary/50 active:bg-primary transition-colors"
                    onMouseDown={(e) =>
                      handleSectionResizeStart(e, prev.id, panel.id)
                    }
                  />
                )}
                <div
                  data-section-id={panel.id}
                  className={cn(
                    "flex flex-col min-h-0 border-b border-border last:border-b-0",
                    sectionCollapsed && "shrink-0"
                  )}
                  style={
                    sectionCollapsed
                      ? undefined
                      : {
                          flexGrow: sectionWeights[panel.id] ?? 1,
                          flexBasis: 0,
                        }
                  }
                >
                {/* Section header: chevron toggles the body; ✕ closes the panel. */}
                <div className="flex items-center h-9 pl-1 pr-1.5 border-b border-border shrink-0">
                  <button
                    onClick={() => toggleSectionCollapsed(panel.id)}
                    className="flex items-center gap-1 flex-1 min-w-0 h-full text-left text-muted-foreground hover:text-foreground transition-colors"
                    aria-expanded={!sectionCollapsed}
                  >
                    {sectionCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-foreground tracking-wide truncate">
                      {panel.label}
                    </span>
                  </button>
                  <button
                    onClick={() => closePanel(panel.id)}
                    aria-label={`Close ${panel.label}`}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* Section body */}
                {!sectionCollapsed && (
                  <div className="flex-1 overflow-auto p-2 min-h-0">
                    <Body />
                  </div>
                )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {/* Icon rail. The 44px placeholder reserves the footprint in-flow; the
          rail itself is absolutely positioned so hover-expand grows leftward
          over the canvas without reflowing it (#135). */}
      <div className="relative w-11 shrink-0">
        <div
          className={cn(
            "absolute top-0 z-30 h-full flex flex-col overflow-hidden",
            // Rail hugs the window edge and hover-expands over the canvas.
            onLeft ? "left-0 border-r" : "right-0 border-l",
            "bg-card border-border",
            "transition-[width] duration-150 ease-out",
            railExpanded && "shadow-xl"
          )}
          style={{ width: railExpanded ? 184 : 44 }}
          onMouseEnter={() => setRailExpanded(true)}
          onMouseLeave={() => {
            if (!dragId) setRailExpanded(false);
          }}
          onFocusCapture={() => setRailExpanded(true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setRailExpanded(false);
            }
          }}
        >
          {/* Collapse/expand toggle */}
          <button
            onClick={toggleCollapse}
            className={cn(
              "flex items-center h-9 w-full shrink-0 overflow-hidden",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors border-b border-border"
            )}
          >
            <span className="flex items-center justify-center w-11 shrink-0">
              {collapsed ? (
                onLeft ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )
              ) : onLeft ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelRightClose className="h-4 w-4" />
              )}
            </span>
            <span
              className={cn(
                "flex-1 min-w-0 truncate whitespace-nowrap pr-2 text-left text-sm",
                "transition-opacity duration-150",
                railExpanded ? "opacity-100" : "opacity-0"
              )}
            >
              {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </span>
          </button>

          {/* Panel rows (reorderable; labels revealed on hover) */}
          {orderedPanels.map((panel) => {
            const Icon = panel.icon;
            // Highlight every panel currently open in the stack (not just one).
            const isActive = !collapsed && openPanels.includes(panel.id);
            const isDragTarget =
              dragOverId === panel.id && dragId !== panel.id;

            return (
              <button
                key={panel.id}
                data-panel-id={panel.id}
                onMouseDown={(e) => handleReorderPointerDown(e, panel.id)}
                onClick={() => handlePanelClick(panel.id)}
                className={cn(
                  "group relative flex items-center h-11 w-full shrink-0 overflow-hidden",
                  "transition-colors duration-150",
                  isActive
                    ? "text-primary bg-primary/8"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                  isDragTarget && "border-t-2 border-t-primary",
                  dragId === panel.id && "opacity-40"
                )}
              >
                {/* Active indicator bar — sits on the canvas-facing edge. */}
                {isActive && (
                  <div
                    className={cn(
                      "absolute top-1.5 bottom-1.5 w-0.5 bg-primary",
                      onLeft ? "right-0 rounded-l" : "left-0 rounded-r"
                    )}
                  />
                )}
                <span className="relative flex items-center justify-center w-11 shrink-0">
                  <Icon className="h-[18px] w-[18px]" />
                  {/* Unread notification badge */}
                  {panel.id === "notifications" && unreadCount > 0 && (
                    <span className="absolute top-1 right-1 h-3.5 min-w-3.5 flex items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground px-0.5">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "flex-1 min-w-0 truncate whitespace-nowrap pr-6 text-left text-sm",
                    "transition-opacity duration-150",
                    railExpanded ? "opacity-100" : "opacity-0"
                  )}
                >
                  {panel.label}
                </span>
                {/* Drag grip (visible on hover) */}
                <GripVertical className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 opacity-0 group-hover:opacity-30 transition-opacity" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
