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

import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { VideoPlayer } from "../video/VideoPlayer";

import { VideosPanel } from "../panels/VideosPanel";
import { SkeletonPanel } from "../panels/SkeletonPanel";
import { InstancesPanel } from "../panels/InstancesPanel";
import { SuggestionsPanel } from "../panels/SuggestionsPanel";
import { ViewPanel } from "../panels/ViewPanel";
import { DebugPanel } from "../panels/DebugPanel";
import { NotificationsPanel } from "../panels/NotificationsPanel";
import { EnvironmentPanel } from "../panels/EnvironmentPanel";
import { WelcomeScreen } from "./WelcomeScreen";
import { TrainingDialog } from "../dialogs/TrainingDialog";
import { InferenceDialog } from "../dialogs/InferenceDialog";
import { GoToFrameDialog } from "../dialogs/GoToFrameDialog";
import { DeletePredictionsDialog } from "../dialogs/DeletePredictionsDialog";
import { ExportDialog } from "../dialogs/ExportDialog";
import { ShortcutsDialog } from "../dialogs/ShortcutsDialog";
import { HelpDialog } from "../dialogs/HelpDialog";
import { InferenceMonitor } from "@/components/monitors/InferenceMonitor";
import { useAppStore } from "../../stores/appStore";
import { loadProjectFromFile } from "../../lib/loadProject";
import {
  Film,
  Bone,
  Users,
  Lightbulb,
  Bug,
  Eye,
  Bell,
  PanelRightClose,
  PanelRightOpen,
  GripVertical,
  Cpu,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  notificationListeners,
  getUnreadCount,
  markAllRead,
} from "../../lib/notificationStore";

/** Panel definitions with icons. */
const PANELS = [
  { id: "videos", label: "Videos", icon: Film, component: VideosPanel },
  { id: "skeleton", label: "Skeleton", icon: Bone, component: SkeletonPanel },
  { id: "instances", label: "Instances", icon: Users, component: InstancesPanel },
  { id: "view", label: "View", icon: Eye, component: ViewPanel },
  { id: "suggestions", label: "Suggestions", icon: Lightbulb, component: SuggestionsPanel },
  { id: "environment", label: "Environment", icon: Cpu, component: EnvironmentPanel },
  { id: "notifications", label: "Notifications", icon: Bell, component: NotificationsPanel },
  { id: "debug", label: "Debug", icon: Bug, component: DebugPanel },
] as const;

export function AppShell() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const isLoading = useAppStore((s) => s.isLoading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);

  // Dialog state
  const deletePredictionsDialogOpen = useAppStore(
    (s) => s.deletePredictionsDialogOpen
  );
  const setDeletePredictionsDialogOpen = useAppStore(
    (s) => s.setDeletePredictionsDialogOpen
  );
  const exportDialogOpen = useAppStore((s) => s.exportDialogOpen);
  const setExportDialogOpen = useAppStore((s) => s.setExportDialogOpen);
  const shortcutsDialogOpen = useAppStore((s) => s.shortcutsDialogOpen);
  const setShortcutsDialogOpen = useAppStore((s) => s.setShortcutsDialogOpen);
  const helpDialogOpen = useAppStore((s) => s.helpDialogOpen);
  const setHelpDialogOpen = useAppStore((s) => s.setHelpDialogOpen);

  // Unsaved changes protection: warn before closing/refreshing
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useAppStore.getState().hasChanges) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Global drag-and-drop for SLP files (uses consolidated loader)
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".slp")) {
      await loadProjectFromFile(file);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  return (
    <div
      className="flex flex-col h-full w-full bg-background"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <MenuBar />

      <ErrorBoundary>
        <div className="flex-1 flex overflow-hidden relative">
          {projectLoaded ? (
            <div className="flex-1 flex min-w-0 h-full">
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

          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">
                  {loadingMessage || "Loading..."}
                </p>
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>

      <InferenceMonitor />
      <StatusBar />

      {/* Global dialogs */}
      <TrainingDialog />
      <InferenceDialog />
      <GoToFrameDialog />
      <DeletePredictionsDialog
        open={deletePredictionsDialogOpen}
        onOpenChange={setDeletePredictionsDialogOpen}
      />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
      <ShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />
      <HelpDialog
        open={helpDialogOpen}
        onOpenChange={setHelpDialogOpen}
      />

      {/* Toast notifications */}
      <Toaster
        theme="dark"
        position="bottom-right"
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
  const activePanel = useAppStore((s) => s.sidebarActivePanel);
  const panelOrder = useAppStore((s) => s.panelOrder);
  const set = useAppStore((s) => s.set);

  // Sidebar resize state
  const [panelWidth, setPanelWidth] = useState(320);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Drag-to-reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Notification unread badge
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const listener = () => setUnreadCount(getUnreadCount());
    notificationListeners.add(listener);
    return () => { notificationListeners.delete(listener); };
  }, []);

  const togglePanel = (panelId: string) => {
    if (collapsed || activePanel !== panelId) {
      set("sidebarActivePanel", panelId);
      set("sidebarCollapsed", false);
      if (panelId === "notifications") markAllRead();
    } else {
      set("sidebarCollapsed", true);
    }
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
      // Dragging left increases width (sidebar is on right)
      const delta = startX.current - e.clientX;
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
  }, [panelWidth]);

  // Drag-to-reorder handlers
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };

  const handleDrop = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === dropIdx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const newOrder = [...panelOrder];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(dropIdx, 0, moved);
    set("panelOrder", newOrder);
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  // Get ordered panels
  const orderedPanels = panelOrder
    .map((id) => PANELS.find((p) => p.id === id))
    .filter(Boolean) as typeof PANELS[number][];

  // Find active panel component
  const ActiveComponent = PANELS.find((p) => p.id === activePanel)?.component;

  return (
    <div className="flex h-full shrink-0">
      {/* Resize handle (only when expanded) */}
      {!collapsed && (
        <div
          className="w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary bg-border transition-colors"
          onMouseDown={handleResizeStart}
        />
      )}

      {/* Expanded panel content */}
      {!collapsed && ActiveComponent && (
        <div
          className="h-full bg-card flex flex-col overflow-hidden"
          style={{ width: panelWidth }}
        >
          {/* Panel header */}
          <div className="flex items-center h-9 px-3 border-b border-border shrink-0">
            <span className="text-sm font-medium text-foreground tracking-wide">
              {PANELS.find((p) => p.id === activePanel)?.label}
            </span>
          </div>
          {/* Panel content */}
          <div className="flex-1 overflow-auto p-2 min-h-0">
            <ActiveComponent />
          </div>
        </div>
      )}

      {/* Icon strip */}
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-col w-11 bg-card border-l border-border shrink-0">
          {/* Collapse/expand toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleCollapse}
                className={cn(
                  "flex items-center justify-center h-9 w-full",
                  "text-muted-foreground hover:text-foreground hover:bg-accent",
                  "transition-colors border-b border-border"
                )}
              >
                {collapsed ? (
                  <PanelRightOpen className="h-4 w-4" />
                ) : (
                  <PanelRightClose className="h-4 w-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</p>
            </TooltipContent>
          </Tooltip>

          {/* Panel icons (reorderable) */}
          {orderedPanels.map((panel, idx) => {
            const Icon = panel.icon;
            const isActive = !collapsed && activePanel === panel.id;
            const isDragTarget = dragOverIdx === idx && dragIdx !== idx;

            return (
              <Tooltip key={panel.id}>
                <TooltipTrigger asChild>
                  <button
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={(e) => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    onClick={() => togglePanel(panel.id)}
                    className={cn(
                      "group relative flex items-center justify-center h-11 w-full",
                      "transition-all duration-150",
                      isActive
                        ? "text-primary bg-primary/8"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                      isDragTarget && "border-t-2 border-t-primary",
                      dragIdx === idx && "opacity-40"
                    )}
                  >
                    {/* Active indicator bar */}
                    {isActive && (
                      <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-r" />
                    )}
                    <Icon className="h-[18px] w-[18px]" />
                    {/* Unread notification badge */}
                    {panel.id === "notifications" && unreadCount > 0 && (
                      <span className="absolute top-1 right-1 h-3.5 min-w-3.5 flex items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground px-0.5">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                    {/* Drag grip (visible on hover) */}
                    <GripVertical className="absolute right-0.5 top-1/2 -translate-y-1/2 h-3 w-3 opacity-0 group-hover:opacity-30 transition-opacity" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  <p>{panel.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </div>
  );
}
