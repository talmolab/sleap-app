/**
 * Menu command palette ("Search the menus", #278).
 *
 * A lightweight, filterable list of the app's common menu actions. Typing
 * filters by label/group; Up/Down move the highlight and Enter runs the
 * highlighted action (clicking runs it too). This is a curated FIRST CUT — it
 * covers the frequently-used File/Edit/Go/View/Labels/Tracks/Predict/Help
 * commands, not every menu item. Each action reuses the exact same handler the
 * menu item calls (commandContext.execute or the store method), so behavior
 * stays in one place.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { modKey, isTauri } from "../../lib/platform";
import { openNewInstance } from "@/lib/newInstance";
import {
  commandContext,
  OpenProjectCommand,
  SaveProjectCommand,
  SaveAsProjectCommand,
  ImportNwbCommand,
  ImportCocoCommand,
  ImportDlcCommand,
  ImportAnalysisH5Command,
  ExportJsonCommand,
  ExportCSVCommand,
  ExportAnalysisH5Command,
  ExportNwbCommand,
  ExportPackageCommand,
  GoNextLabeledFrame,
  GoPrevLabeledFrame,
  GoNextSuggestion,
  GoPrevSuggestion,
  GoToLastInteracted,
  GoNextUserFrame,
  GoNextTrackSpawnFrame,
  AddInstance,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  DeleteFramePredictions,
  AddInstancesFromAllPredictions,
  AddInstancesFromAllPredictionsInProject,
  AddTrack,
  TransposeInstances,
  CopyTrack,
  PasteTrack,
  DeleteUnusedTracks,
} from "../../commands";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface MenuAction {
  group: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}

/** Nudge the manual UI scale, mirroring the +/- Text Size controls. */
function adjustScale(delta: number) {
  const s = useAppStore.getState();
  const newScale = Math.max(0.75, Math.min(1.5, s.uiScale + delta));
  s.set("uiScale", Math.round(newScale * 100) / 100);
  document.documentElement.style.setProperty("--ui-scale", String(newScale));
}

/** The curated command registry. Built once; each `run` reads fresh state. */
function buildActions(): MenuAction[] {
  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => () =>
    commandContext.execute(cmd);
  const store = () => useAppStore.getState();

  return [
    // File
    { group: "File", label: "New Project", shortcut: `${modKey}+N`, run: () => void openNewInstance() },
    { group: "File", label: "Open Project", shortcut: `${modKey}+O`, run: exec(OpenProjectCommand) },
    { group: "File", label: "Save", shortcut: `${modKey}+S`, run: exec(SaveProjectCommand) },
    { group: "File", label: "Save As", shortcut: `${modKey}+Shift+S`, run: exec(SaveAsProjectCommand) },
    { group: "File", label: "Import NWB dataset", run: exec(ImportNwbCommand) },
    { group: "File", label: "Import COCO dataset", run: exec(ImportCocoCommand) },
    { group: "File", label: "Import DeepLabCut dataset", run: exec(ImportDlcCommand) },
    { group: "File", label: "Import Analysis HDF5", run: exec(ImportAnalysisH5Command) },
    { group: "File", label: "Export JSON", run: exec(ExportJsonCommand) },
    { group: "File", label: "Export Analysis CSV", run: exec(ExportCSVCommand) },
    { group: "File", label: "Export Analysis HDF5", run: exec(ExportAnalysisH5Command) },
    { group: "File", label: "Export NWB (ndx-pose)", run: exec(ExportNwbCommand) },
    { group: "File", label: "Export Labels Package", run: exec(ExportPackageCommand) },
    { group: "File", label: "Export Labeled Clip (Video)", run: () => store().setExportClipDialogOpen(true) },

    // Edit
    { group: "Edit", label: "Undo", shortcut: `${modKey}+Z`, run: () => commandContext.undo() },
    { group: "Edit", label: "Redo", shortcut: `${modKey}+Shift+Z`, run: () => commandContext.redo() },
    { group: "Edit", label: "Copy Instance", shortcut: `${modKey}+C`, run: exec(CopyInstance) },
    { group: "Edit", label: "Paste Instance", shortcut: `${modKey}+V`, run: exec(PasteInstance) },
    { group: "Edit", label: "Add Instance", shortcut: `${modKey}+I`, run: exec(AddInstance) },
    { group: "Edit", label: "Delete Instance", run: exec(DeleteSelectedInstance) },
    { group: "Edit", label: "Delete Predictions on Current Frame", run: exec(DeleteFramePredictions) },

    // Go
    { group: "Go", label: "Go to Frame", shortcut: `${modKey}+J`, run: () => store().setGoToFrameDialogOpen(true) },
    { group: "Go", label: "Select to Frame", shortcut: `${modKey}+Shift+J`, run: () => store().setSelectToFrameDialogOpen(true) },
    { group: "Go", label: "Next Labeled Frame", run: exec(GoNextLabeledFrame) },
    { group: "Go", label: "Previous Labeled Frame", run: exec(GoPrevLabeledFrame) },
    { group: "Go", label: "Next Suggestion", run: exec(GoNextSuggestion) },
    { group: "Go", label: "Previous Suggestion", run: exec(GoPrevSuggestion) },
    { group: "Go", label: "Last Interacted Frame", shortcut: `${modKey}+A`, run: exec(GoToLastInteracted) },
    { group: "Go", label: "Next User Labeled Frame", shortcut: `${modKey}+U`, run: exec(GoNextUserFrame) },
    { group: "Go", label: "Next Track Spawn Frame", shortcut: `${modKey}+E`, run: exec(GoNextTrackSpawnFrame) },
    { group: "Go", label: "Clear Selection", shortcut: "Esc", run: () => store().setInstance(null) },
    { group: "Go", label: "Navigate All Frames", run: () => store().setNavigationDomain("all") },
    { group: "Go", label: "Navigate Labeled Frames Only", run: () => store().setNavigationDomain("labeled") },
    { group: "Go", label: "Navigate Imaged Frames Only", run: () => store().setNavigationDomain("imaged") },

    // View
    { group: "View", label: "Toggle Side Panel", run: () => store().toggle("sidebarCollapsed") },
    { group: "View", label: "Sidebar on Left", run: () => store().set("sidebarSide", store().sidebarSide === "left" ? "right" : "left") },
    { group: "View", label: "Multi-Panel Sidebar", run: () => store().setSidebarMultiPanel(!store().sidebarMultiPanel) },
    { group: "View", label: "Node Placement Mode", shortcut: "N", run: () => store().set("labelingMode", store().labelingMode === "place" ? "select" : "place") },
    { group: "View", label: "Reset Text Size", run: () => store().set("uiScale", 1) },
    { group: "View", label: "Fit View to Instances", run: () => store().toggle("fit") },
    { group: "View", label: "Fit View to Selection", run: () => store().set("fitSelection", true) },
    { group: "View", label: "Default to Pan Mode", shortcut: "P", run: () => store().toggle("defaultToPan") },
    { group: "View", label: "Show Instances", run: () => store().toggle("showInstances") },
    { group: "View", label: "Show Non-Visible Nodes", shortcut: "V", run: () => store().toggle("showNonVisibleNodes") },
    { group: "View", label: "Show Node Names", run: () => store().toggle("showLabels") },
    { group: "View", label: "Show Edges", run: () => store().toggle("showEdges") },
    { group: "View", label: "Color Predicted Instances", run: () => store().toggle("colorPredicted") },
    { group: "View", label: "Crosshair When Zoomed", run: () => store().toggle("showCrosshair") },
    { group: "View", label: "Increase Text Size", run: () => adjustScale(0.05) },
    { group: "View", label: "Decrease Text Size", run: () => adjustScale(-0.05) },

    // Labels
    { group: "Labels", label: "Accept All Predictions on Current Frame", shortcut: `${modKey}+Shift+A`, run: exec(AddInstancesFromAllPredictions) },
    { group: "Labels", label: "Accept All Predictions (Project)", run: exec(AddInstancesFromAllPredictionsInProject) },
    { group: "Labels", label: "Delete Predictions...", run: () => store().setDeletePredictionsDialogOpen(true) },

    // Tracks
    { group: "Tracks", label: "Transpose Instance Tracks", shortcut: `${modKey}+T`, run: exec(TransposeInstances) },
    { group: "Tracks", label: "New Track", shortcut: `${modKey}+0`, run: exec(AddTrack) },
    { group: "Tracks", label: "Copy Instance Track", shortcut: `${modKey}+Shift+C`, run: exec(CopyTrack) },
    { group: "Tracks", label: "Paste Instance Track", shortcut: `${modKey}+Shift+V`, run: exec(PasteTrack) },
    { group: "Tracks", label: "Delete Unused Tracks", run: () => { if (confirm("Delete all unused tracks?")) commandContext.execute(DeleteUnusedTracks); } },

    // Predict
    { group: "Predict", label: "Training...", run: () => store().openPanel("training") },
    { group: "Predict", label: "Inference / Run Prediction...", run: () => store().openPanel("inference") },
    { group: "Predict", label: "Evaluation Metrics for Trained Models...", run: () => store().setModelMetricsDialogOpen(true) },
    { group: "Predict", label: "Export Labels Package...", run: () => store().setExportPackageDialogOpen(true) },

    // Help
    { group: "Help", label: "Start Tutorial", run: () => store().startTutorial() },
    { group: "Help", label: "Keyboard Shortcuts", run: () => store().setShortcutsDialogOpen(true) },
    { group: "Help", label: "Documentation", run: () => void openExternal("https://docs.sleap.ai/") },
    { group: "Help", label: "Report Issue", run: () => void openExternal("https://github.com/talmolab/sleap-app/issues") },
    { group: "Help", label: "About SLEAP Label", run: () => store().setHelpDialogOpen(true) },
  ];
}

export function MenuSearchDialog() {
  const open = useAppStore((s) => s.menuSearchDialogOpen);
  const setOpen = useAppStore((s) => s.setMenuSearchDialogOpen);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useMemo(() => buildActions(), []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q),
    );
  }, [actions, query]);

  // Reset the query/highlight each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Keep the highlight in range as the filter narrows.
  useEffect(() => {
    setActive((a) => (a >= filtered.length ? 0 : a));
  }, [filtered.length]);

  const runAction = (a: MenuAction | undefined) => {
    if (!a) return;
    setOpen(false);
    // Defer so this palette fully unmounts before an action that opens another
    // dialog mounts — avoids two Radix dialogs fighting over focus.
    requestAnimationFrame(() => a.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAction(filtered[active]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 overflow-hidden sm:max-w-[560px]"
      >
        <DialogTitle className="sr-only">Search menus</DialogTitle>
        <div className="relative border-b border-border">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search menus..."
            aria-label="Filter menu commands"
            className="h-11 rounded-none border-0 pl-9 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No matching commands.
            </p>
          ) : (
            filtered.map((a, i) => (
              <button
                key={`${a.group}:${a.label}`}
                type="button"
                onClick={() => runAction(a)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  i === active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground w-14">
                    {a.group}
                  </span>
                  <span className="truncate">{a.label}</span>
                </span>
                {a.shortcut && (
                  <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {a.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
