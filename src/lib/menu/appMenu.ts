/**
 * The app's menus, as data (see `types.ts`): `buildAppMenu(snapshot)` is the
 * single definition the in-window menu bar, Search Menus and the native menu
 * render from. `snapshot` is everything that changes what a menu shows
 * (checked, enabled, labels, the video/track lists); each `run` reads fresh
 * store state when it fires.
 */

import type { NavigationDomain } from "@/stores/appStore";
import { useAppStore } from "@/stores/appStore";
import { useExportStore } from "@/stores/exportStore";
import { useSlpFormatStore } from "@/stores/slpFormatStore";
import { PANELS } from "@/components/layout/panelRegistry";
import { DEFAULT_SHORTCUTS } from "@/lib/shortcuts";
import { getDocsUrl } from "@/lib/docsUrl";
import { QC_MODE_CHOICES } from "@/lib/instanceVisibility";
import { toast } from "@/lib/notify";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { confirmDialog } from "@/stores/confirmStore";
import { confirmAndResetPreferences } from "@/lib/preferences";
import { promptDialog } from "@/stores/promptStore";
import { AcceptAllBboxes, DeletePredictedBboxes } from "@/commands/bboxCommands";
import { AcceptAllCentroids, DeletePredictedCentroids } from "@/commands/centroidCommands";
import {
  confirmDeleteInstanceAndTrack,
  confirmDeleteUnusedTracks,
} from "@/lib/trackDeleteConfirms";
import { openNewInstance } from "@/lib/newInstance";
import { requestStartTutorial } from "@/lib/tutorial/startTutorial";
import { requestToggleNegativeFrame } from "@/lib/negativeFrame";
import { predictionsInClip } from "@/lib/predictionDeletion";
import {
  GRAPH_SPECS,
  reconcileReduction,
  type Reduction,
  type StatisticGraphType,
} from "@/lib/statisticSeries";
import {
  commandContext,
  OpenProjectCommand,
  ImportAnalysisH5Command,
  ImportNwbCommand,
  ImportCocoCommand,
  ImportDlcCommand,
  ImportDlcFolderCommand,
  SaveProjectCommand,
  SaveAsProjectCommand,
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
  GoPrevUserFrame,
  GoToMarkedFrame,
  GoNextTrackSpawnFrame,
  GoNextQcFlag,
  GoPrevQcFlag,
  MarkQcFlagOk,
  AddInstance,
  DeleteSelectedInstance,
  MergeInstance,
  CopyInstance,
  PasteInstance,
  DeleteFramePredictions,
  DeleteAllPredictions,
  DeletePredictionsFromClip,
  AddInstancesFromAllPredictions,
  AddInstancesFromAllPredictionsInProject,
  AddTrack,
  SetInstanceTrack,
  requestTranspose,
  CopyTrack,
  PasteTrack,
  DeleteInstanceAndTrack,
  DeleteTrack,
  DeleteUnusedTracks,
  DeleteAllTracks,
} from "@/commands";
import {
  adjustUiScale,
  clearVideoTranscodeCache,
  cycleVideo,
  markFrame,
  openExternal,
  openPreferencesDirectory,
  quit,
  replaceVideo,
  resetUiScale,
  revealProjectInFileManager,
  selectNextInstance,
  togglePlacementMode,
} from "./menuActions";
import type { AppMenu, MenuNode, MenuRadioNode, TopAction, TopMenu } from "./types";
import { countMenu } from "@/lib/analytics";
import { usageDataEnabled } from "@/lib/analytics/consent";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useCustomDeleteDialog } from "@/stores/customDeleteDialogStore";

/** Everything that changes what the menus show. */
export interface MenuSnapshot {
  isTauri: boolean;
  /** Help ▸ Share Usage Data, as it takes effect (see `usageDataEnabled`). */
  shareUsageData: boolean;
  projectLoaded: boolean;
  hasProjectPath: boolean;
  videoNames: string[];
  trackNames: string[];
  hasInstance: boolean;
  hasClipboardInstance: boolean;
  skeletonHasNodes: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  navigationDomain: NavigationDomain;
  sidebarCollapsed: boolean;
  sidebarSide: "left" | "right";
  sidebarMultiPanel: boolean;
  fit: boolean;
  followSelection: boolean;
  actualSize: boolean;
  defaultToPan: boolean;
  placementMode: boolean;
  showInstances: boolean;
  showNonVisibleNodes: boolean;
  qcDisplayMode: string;
  showLabels: boolean;
  showEdges: boolean;
  bboxDrawMode: boolean;
  showInset: boolean;
  colorPredicted: boolean;
  scrubProxyEnabled: boolean;
  hiddenPanels: string[];
  instanceInitMethod: string;
  showLabelingHints: boolean;
  frameIsNegative: boolean;
  hasFrameRange: boolean;
  totalLabeled: number;
  totalInstances: number;
  overlayModelCount: number;
  overlayModelOutputs: boolean;
  propagateTrackLabels: boolean;
  seekbarHeaderGraph: string;
}

type Cmd = Parameters<typeof commandContext.execute>[0];
type CmdParams = Parameters<typeof commandContext.execute>[1];
const exec = (cmd: Cmd, params?: CmdParams) => () => {
  commandContext.execute(cmd, params);
};
const store = () => useAppStore.getState();
const SEP = { kind: "separator" } as const;

function radio(
  id: string,
  value: string,
  options: [value: string, label: string][],
  select: (v: string) => void,
  enabled?: boolean,
): MenuRadioNode {
  return {
    kind: "radio",
    id,
    value,
    options: options.map(([v, label]) => ({ value: v, label, enabled })),
    select,
  };
}

function fileMenu(s: MenuSnapshot): TopMenu {
  const loaded = s.projectLoaded;
  const items: MenuNode[] = [
    { kind: "item", id: "file.new", label: "New Project...", shortcut: "$mod+KeyN", run: () => void openNewInstance() },
    { kind: "item", id: "file.open", label: "Open Project...", shortcut: "$mod+KeyO", run: exec(OpenProjectCommand) },
    {
      kind: "submenu",
      id: "file.import",
      label: "Import",
      items: [
        { kind: "item", id: "file.import.analysisH5", label: "Analysis HDF5...", run: exec(ImportAnalysisH5Command) },
        { kind: "item", id: "file.import.nwb", label: "NWB dataset...", run: exec(ImportNwbCommand) },
        { kind: "item", id: "file.import.coco", label: "COCO dataset...", run: exec(ImportCocoCommand) },
        { kind: "item", id: "file.import.dlc", label: "DeepLabCut dataset...", run: exec(ImportDlcCommand) },
        { kind: "item", id: "file.import.dlcFolder", label: "Multiple DeepLabCut datasets from folder...", run: exec(ImportDlcFolderCommand) },
      ],
    },
    { kind: "item", id: "file.merge", label: "Merge into Project...", enabled: loaded, run: () => store().setMergeProjectDialogOpen(true) },
    {
      kind: "submenu",
      id: "file.replaceVideo",
      label: "Replace Videos...",
      enabled: loaded,
      scroll: true,
      items: s.videoNames.map((name, idx) => ({
        kind: "item" as const,
        id: `file.replaceVideo.${idx}`,
        label: name,
        run: () => replaceVideo(idx),
      })),
    },
    { kind: "item", id: "file.addVideoUrl", label: "Add Video from URL...", enabled: loaded, run: () => store().setAddVideoUrlDialogOpen(true) },
    SEP,
    { kind: "item", id: "file.save", label: "Save", shortcut: "$mod+KeyS", enabled: loaded, run: exec(SaveProjectCommand) },
    { kind: "item", id: "file.saveAs", label: "Save As...", shortcut: "$mod+Shift+KeyS", enabled: loaded, run: exec(SaveAsProjectCommand) },
    SEP,
    {
      kind: "submenu",
      id: "file.export",
      label: "Export",
      enabled: loaded,
      items: [
        { kind: "item", id: "file.export.json", label: "JSON...", run: exec(ExportJsonCommand) },
        {
          kind: "submenu",
          id: "file.export.csv",
          label: "Analysis CSV",
          items: [
            { kind: "item", id: "file.export.csv.current", label: "Current Video...", run: exec(ExportCSVCommand) },
            { kind: "item", id: "file.export.csv.all", label: "All Videos...", run: exec(ExportCSVCommand, { allVideos: true }) },
          ],
        },
        {
          kind: "submenu",
          id: "file.export.analysisH5",
          label: "Analysis HDF5",
          items: [
            { kind: "item", id: "file.export.analysisH5.current", label: "Current Video...", run: exec(ExportAnalysisH5Command) },
            { kind: "item", id: "file.export.analysisH5.all", label: "All Videos...", run: exec(ExportAnalysisH5Command, { allVideos: true }) },
          ],
        },
        { kind: "item", id: "file.export.nwb", label: "NWB (ndx-pose)...", run: exec(ExportNwbCommand) },
        { kind: "item", id: "file.export.slpCopy", label: "SLP Copy...", run: () => useSlpFormatStore.getState().openSaveSlpCopyDialog("auto") },
        { kind: "item", id: "file.export.pkg", label: "Labels Package (.pkg.slp)...", run: () => store().setExportPackageDialogOpen(true) },
        { kind: "item", id: "file.export.jsonPackage", label: "JSON Package...", run: exec(ExportPackageCommand) },
        { kind: "item", id: "file.export.clip", label: "Labeled Clip (Video)...", run: () => store().setExportClipDialogOpen(true) },
      ],
    },
  ];
  items.push(SEP);
  if (s.isTauri) {
    items.push({ kind: "item", id: "file.reveal", label: "Reveal Project in File Manager", enabled: s.hasProjectPath, run: revealProjectInFileManager });
  }
  // PyQt SLEAP: File ▸ "Reset preferences to defaults...", just above Open
  // Preferences Directory. Asks first (Tauri-safe in-app confirm).
  items.push({ kind: "item", id: "file.resetPreferences", label: "Reset Preferences to Defaults...", run: () => void confirmAndResetPreferences() });
  if (s.isTauri) {
    items.push(
      { kind: "item", id: "file.preferencesDir", label: "Open Preferences Directory...", run: openPreferencesDirectory },
      { kind: "item", id: "file.clearTranscodeCache", label: "Clear Video Transcode Cache...", run: clearVideoTranscodeCache },
    );
  }
  items.push(SEP, { kind: "item", id: "file.quit", label: "Quit", shortcut: "$mod+KeyQ", run: quit });
  return { kind: "menu", id: "file", label: "File", tutorialId: "file-menu-trigger", items };
}

/** Undo/Redo and the instance clipboard (PyQt SLEAP has no Edit menu; they're under Labels). */
function undoItems(s: MenuSnapshot): MenuNode[] {
  return [
    { kind: "item", id: "labels.undo", label: s.undoLabel ?? "Undo", shortcut: "$mod+KeyZ", enabled: s.undoLabel !== null, run: () => void commandContext.undo() },
    { kind: "item", id: "labels.redo", label: s.redoLabel ?? "Redo", shortcut: "$mod+Shift+KeyZ", enabled: s.redoLabel !== null, run: () => void commandContext.redo() },
  ];
}

function clipboardItems(s: MenuSnapshot): MenuNode[] {
  return [
    {
      kind: "item",
      id: "labels.copyInstance",
      label: "Copy Instance",
      shortcut: "$mod+KeyC",
      enabled: s.hasInstance,
      run: () => {
        commandContext.execute(CopyInstance);
        toast.info("Instance copied");
      },
    },
    {
      kind: "item",
      id: "labels.pasteInstance",
      label: "Paste Instance",
      shortcut: "$mod+KeyV",
      enabled: s.hasClipboardInstance && s.skeletonHasNodes,
      run: () => {
        commandContext.execute(PasteInstance);
        toast.info("Instance pasted");
      },
    },
  ];
}

function goMenu(s: MenuSnapshot): TopMenu {
  const loaded = s.projectLoaded;
  const go = (id: string, label: string, run: () => void, shortcut?: string): MenuNode => ({
    kind: "item",
    id: `go.${id}`,
    label,
    shortcut,
    enabled: loaded,
    run,
  });
  return {
    kind: "menu",
    id: "go",
    label: "Go",
    items: [
      go("toFrame", "Go to Frame...", () => store().setGoToFrameDialogOpen(true), "$mod+KeyJ"),
      go("selectToFrame", "Select to Frame...", () => store().setSelectToFrameDialogOpen(true), "$mod+Shift+KeyJ"),
      // PyQt's "medium/large step size" prefs (preferences.yaml only there).
      { kind: "item", id: "go.frameStepSizes", label: "Frame Step Sizes...", run: () => store().set("frameStepSizesDialogOpen", true) },
      SEP,
      go("nextLabeled", "Next Labeled Frame", exec(GoNextLabeledFrame), "Alt+ArrowRight"),
      go("prevLabeled", "Previous Labeled Frame", exec(GoPrevLabeledFrame), "Alt+ArrowLeft"),
      radio(
        "go.navigationDomain",
        s.navigationDomain,
        [
          ["all", "Navigate All Frames"],
          ["labeled", "Navigate Labeled Frames Only"],
          ["suggested", "Navigate Suggested Frames Only"],
          ["imaged", "Navigate Imaged Frames Only"],
        ],
        (v) => store().setNavigationDomain(v as NavigationDomain),
        loaded,
      ),
      SEP,
      go("nextSuggestion", "Next Suggestion", exec(GoNextSuggestion), "Space"),
      go("prevSuggestion", "Previous Suggestion", exec(GoPrevSuggestion), "Shift+Space"),
      SEP,
      go("lastInteracted", "Last Interacted Frame", exec(GoToLastInteracted), "$mod+KeyA"),
      go("nextUser", "Next User Labeled Frame", exec(GoNextUserFrame), "$mod+KeyU"),
      go("prevUser", "Previous User Labeled Frame", exec(GoPrevUserFrame), "$mod+Shift+KeyU"),
      go("nextTrackSpawn", "Next Track Spawn Frame", exec(GoNextTrackSpawnFrame), "$mod+KeyE"),
      go("nextQcFlag", "Next Label QC Flag", exec(GoNextQcFlag), "KeyF"),
      go("prevQcFlag", "Previous Label QC Flag", exec(GoPrevQcFlag), "Shift+KeyF"),
      go("qcMarkOk", "Ignore Label QC Flag", exec(MarkQcFlagOk), "Digit3"),
      SEP,
      go("markFrame", "Mark Frame", markFrame, "$mod+KeyM"),
      go("toMarkedFrame", "Go to Marked Frame", exec(GoToMarkedFrame), "$mod+Shift+KeyM"),
      SEP,
      go("nextVideo", "Next Video", () => cycleVideo(1), "Alt+Shift+ArrowRight"),
      go("prevVideo", "Previous Video", () => cycleVideo(-1), "Alt+Shift+ArrowLeft"),
      SEP,
      go("nextInstance", "Select Next Instance", selectNextInstance, "Backquote"),
      go("clearSelection", "Clear Selection", () => store().setInstance(null), "Escape"),
    ],
  };
}

function viewMenu(s: MenuSnapshot): TopMenu {
  const toggle = (key: Parameters<ReturnType<typeof store>["toggle"]>[0]) => () => store().toggle(key);
  const sub = (id: string, label: string, node: MenuNode): MenuNode => ({
    kind: "submenu",
    id: `view.${id}`,
    label,
    items: [node],
  });
  return {
    kind: "menu",
    id: "view",
    label: "View",
    items: [
      {
        kind: "item",
        id: "view.openPanel",
        label: "Open View Panel",
        title: "Open the View panel for overlay, style, color, trail, and intensity settings",
        run: () => {
          const st = store();
          if (st.hiddenPanels.includes("view")) st.togglePanelVisibility("view");
          st.openPanel("view");
        },
      },
      SEP,
      { kind: "check", id: "view.sidePanel", label: "Side Panel", checked: !s.sidebarCollapsed, run: toggle("sidebarCollapsed") },
      {
        kind: "check",
        id: "view.sidebarLeft",
        label: "Sidebar on Left",
        checked: s.sidebarSide === "left",
        run: () => store().set("sidebarSide", store().sidebarSide === "left" ? "right" : "left"),
      },
      {
        kind: "check",
        id: "view.multiPanel",
        label: "Allow Multiple Panels",
        checked: s.sidebarMultiPanel,
        run: () => store().setSidebarMultiPanel(!store().sidebarMultiPanel),
      },
      panelsSubmenu(s),
      SEP,
      // PyQt's three zoom modes; turning one on turns the others off.
      { kind: "check", id: "view.fit", label: "Fit View to Instances", checked: s.fit, run: () => store().setZoomMode("fit", !s.fit) },
      {
        kind: "check",
        id: "view.fitSelection",
        label: "Fit View to Selection",
        checked: s.followSelection,
        run: () => store().setZoomMode("followSelection", !s.followSelection),
      },
      { kind: "check", id: "view.actualSize", label: "Actual Size (1:1)", checked: s.actualSize, run: () => store().setZoomMode("actualSize", !s.actualSize) },
      // Zoom to the selected instance once, without following it afterwards.
      { kind: "item", id: "view.zoomToSelection", label: "Zoom to Selection", enabled: s.hasInstance, run: () => store().set("fitSelection", true) },
      { kind: "check", id: "view.defaultToPan", label: "Default to Pan Mode", shortcut: DEFAULT_SHORTCUTS["toggle pan mode"], checked: s.defaultToPan, run: toggle("defaultToPan") },
      {
        kind: "check",
        id: "view.placementMode",
        label: "Node Placement Mode",
        shortcut: DEFAULT_SHORTCUTS["toggle place mode"],
        checked: s.placementMode,
        enabled: s.hasInstance || s.placementMode,
        run: togglePlacementMode,
      },
      SEP,
      {
        kind: "submenu",
        id: "view.textSize",
        label: "Text Size",
        items: [
          { kind: "item", id: "view.textSize.increase", label: "Increase", shortcut: "$mod+Shift+Equal", run: () => adjustUiScale(0.05) },
          { kind: "item", id: "view.textSize.decrease", label: "Decrease", shortcut: "$mod+Minus", run: () => adjustUiScale(-0.05) },
          SEP,
          { kind: "item", id: "view.textSize.reset", label: "Reset to Default", run: resetUiScale },
        ],
      },
      SEP,
      { kind: "check", id: "view.showInstances", label: "Show Instances", checked: s.showInstances, run: toggle("showInstances") },
      {
        kind: "check",
        id: "view.showNonVisibleNodes",
        label: "Show Non-Visible Nodes",
        shortcut: DEFAULT_SHORTCUTS["show non-visible nodes"],
        checked: s.showNonVisibleNodes,
        run: toggle("showNonVisibleNodes"),
      },
      { kind: "check", id: "view.showLabels", label: "Show Node Names", shortcut: DEFAULT_SHORTCUTS["show labels"], checked: s.showLabels, run: toggle("showLabels") },
      { kind: "check", id: "view.showEdges", label: "Show Edges", checked: s.showEdges, run: toggle("showEdges") },
      { kind: "check", id: "view.colorPredicted", label: "Color Predicted Instances", checked: s.colorPredicted, run: toggle("colorPredicted") },
      sub(
        "display",
        "Display",
        radio(
          "view.display.mode",
          s.qcDisplayMode,
          QC_MODE_CHOICES.map(([label, mode]) => [mode, label]),
          (v) => store().setQcDisplayMode(v as Parameters<ReturnType<typeof store>["setQcDisplayMode"]>[0]),
        ),
      ),
      { kind: "check", id: "view.magnifier", label: "Magnifier When Moving Nodes", checked: s.showInset, run: toggle("showInset") },
      SEP,
      {
        kind: "check",
        id: "view.scrubProxies",
        label: "Create Local Scrub Proxies for Network Videos (Desktop)",
        checked: s.scrubProxyEnabled,
        run: () => store().setScrubProxyEnabled(!store().scrubProxyEnabled),
      },
    ],
  };
}

/** View ▸ Panels: which panels appear in the sidebar strip (#135); PyQt has its docks under View too. */
function panelsSubmenu(s: MenuSnapshot): MenuNode {
  return {
    kind: "submenu",
    id: "view.panels",
    label: "Panels",
    items: [
      ...PANELS.map((panel) => ({
        kind: "check" as const,
        id: `view.panels.${panel.id}`,
        label: panel.label,
        checked: !s.hiddenPanels.includes(panel.id),
        keepOpen: true,
        run: () => store().togglePanelVisibility(panel.id),
      })),
      SEP,
      {
        kind: "item",
        id: "view.panels.reset",
        label: "Reset to Defaults...",
        run: async () => {
          if (await confirmDialog({ message: "Reset panels to their default order and visibility?" })) {
            store().resetPanels();
          }
        },
      },
    ],
  };
}

function labelsMenu(s: MenuSnapshot): TopMenu {
  const loaded = s.projectLoaded;
  return {
    kind: "menu",
    id: "labels",
    label: "Labels",
    items: [
      ...undoItems(s),
      SEP,
      { kind: "item", id: "labels.addInstance", label: "Add Instance", shortcut: "$mod+KeyI", enabled: loaded && s.skeletonHasNodes, run: exec(AddInstance) },
      {
        kind: "submenu",
        id: "labels.placementMethod",
        label: "Instance Placement Method",
        items: [
          radio(
            "labels.placementMethod.value",
            s.instanceInitMethod,
            [
              ["best", "Best"],
              ["template", "Template"],
              ["force_directed", "Force Directed"],
              ["random", "Random"],
              ["prior_frame", "Copy Prior Frame"],
              ["prediction", "Copy Predictions"],
            ],
            (v) => store().set("instanceInitMethod", v as never),
          ),
        ],
      },
      {
        kind: "item",
        id: "labels.deleteInstance",
        label: "Delete Instance",
        shortcut: "$mod+Backspace",
        enabled: s.hasInstance,
        run: () => {
          commandContext.execute(DeleteSelectedInstance);
          toast.info("Instance deleted");
        },
      },
      {
        kind: "item",
        id: "labels.mergeInstance",
        label: "Merge Instance",
        shortcut: DEFAULT_SHORTCUTS["merge instance"],
        // Enabled with any selection: the command explains what's missing
        // (a second user instance, or which one to merge in).
        enabled: s.hasInstance,
        run: exec(MergeInstance),
      },
      // PyQt's place for it: right after Merge Instance (app.py:911).
      { kind: "item", id: "labels.customDelete", label: "Custom Instance Delete...", enabled: loaded, run: () => useCustomDeleteDialog.getState().setOpen(true) },
      ...clipboardItems(s),
      {
        kind: "check",
        id: "labels.markNegative",
        label: "Mark Frame as Negative",
        shortcut: DEFAULT_SHORTCUTS["mark negative"],
        checked: s.frameIsNegative,
        enabled: loaded,
        run: () => void requestToggleNegativeFrame(),
      },
      SEP,
      { kind: "item", id: "labels.acceptFrame", label: "Accept All Predictions on Current Frame", shortcut: "$mod+Shift+KeyA", enabled: loaded, run: exec(AddInstancesFromAllPredictions) },
      { kind: "item", id: "labels.acceptAll", label: "Accept All Predictions", enabled: loaded, run: exec(AddInstancesFromAllPredictionsInProject) },
      { kind: "item", id: "labels.deleteFramePredictions", label: "Delete Predictions on Current Frame", enabled: loaded, run: exec(DeleteFramePredictions) },
      { kind: "item", id: "labels.deletePredictions", label: "Delete Predictions...", enabled: loaded, run: () => store().setDeletePredictionsDialogOpen(true) },
      {
        kind: "item",
        id: "labels.deleteClip",
        label: "Delete Predictions from Clip...",
        // As in PyQt, this needs a frame range selected on the seekbar.
        enabled: loaded && s.hasFrameRange,
        title: "Delete the predictions in the frame range selected on the seekbar, in the current video. Select a range by shift-dragging on the seekbar.",
        run: async () => {
          const { labels, video, frameRange } = store();
          if (!labels || !video || !frameRange) return;
          const [start, end] = frameRange;
          const count = predictionsInClip(labels, video, start, end).length;
          if (count === 0) {
            toast.info("No predictions in the selected clip.");
            return;
          }
          const ok = await confirmDialog({
            title: "Delete predictions from clip",
            message: `There are ${count} predicted instances in frames ${start}-${end} of this video which would be deleted. Delete them?`,
            confirmLabel: "Delete",
            destructive: true,
          });
          if (ok) commandContext.execute(DeletePredictionsFromClip, { startFrame: start, endFrame: end });
        },
      },
      {
        kind: "item",
        id: "labels.deleteArea",
        label: "Delete Predictions from Area...",
        shortcut: "$mod+KeyK",
        enabled: loaded,
        title: "Draw a box on the video: predictions with all their points inside it are deleted on every frame of the current video.",
        run: () => store().toggle("areaDeleteMode"),
      },
      {
        kind: "item",
        id: "labels.deleteAllPredictions",
        label: "Delete All Predictions...",
        enabled: loaded,
        run: async () => {
          const count = (store().labels?.labeledFrames ?? []).reduce(
            (n, lf) => n + lf.instances.filter((i) => i instanceof PredictedInstance).length,
            0,
          );
          const ok = await confirmDialog({
            title: "Delete all predictions",
            message: `There are ${count} predicted instances which would be deleted, across all frames. Delete them?`,
            confirmLabel: "Delete",
            destructive: true,
          });
          if (ok) {
            commandContext.execute(DeleteAllPredictions);
            toast.info("All predictions deleted");
          }
        },
      },
      SEP,
      // Bounding boxes (#488).
      {
        kind: "submenu",
        id: "labels.bboxes",
        label: "Bounding Boxes",
        items: [
          { kind: "check", id: "labels.bboxes.tool", label: "Box Tool", shortcut: "KeyB", checked: s.bboxDrawMode, enabled: loaded, run: () => store().toggle("bboxDrawMode") },
          { kind: "item", id: "labels.bboxes.fromPoses", label: "Boxes from Poses...", enabled: loaded, run: () => store().set("bboxFromPosesOpen", true) },
          SEP,
          {
            kind: "item",
            id: "labels.bboxes.acceptAll",
            label: "Accept Predicted Boxes...",
            enabled: loaded,
            run: async () => {
              const v = await promptDialog({
                title: "Accept predicted boxes",
                message: "Turn every predicted box scoring at least this much into a user box, across all frames.",
                defaultValue: "0.5",
                confirmLabel: "Accept",
              });
              if (v === null) return;
              const minScore = Number(v);
              if (!Number.isFinite(minScore)) return void toast.error("Enter a number, e.g. 0.5");
              commandContext.execute(AcceptAllBboxes, { minScore });
            },
          },
          {
            kind: "item",
            id: "labels.bboxes.deletePredicted",
            label: "Delete Predicted Boxes...",
            enabled: loaded,
            run: async () => {
              const v = await promptDialog({
                title: "Delete predicted boxes",
                message: "Delete predicted boxes scoring below this, across all frames. Leave it empty to delete every predicted box.",
                defaultValue: "0.3",
                confirmLabel: "Delete",
              });
              if (v === null) return;
              const t = v.trim();
              const maxScore = t === "" ? undefined : Number(t);
              if (maxScore !== undefined && !Number.isFinite(maxScore)) return void toast.error("Enter a number, or leave it empty");
              commandContext.execute(DeletePredictedBboxes, { maxScore });
            },
          },
        ],
      },
      // Centroids: a Centroid Only run on a multi-node skeleton predicts these.
      {
        kind: "submenu",
        id: "labels.centroids",
        label: "Centroids",
        items: [
          {
            kind: "item",
            id: "labels.centroids.acceptAll",
            label: "Accept Predicted Centroids...",
            enabled: loaded,
            run: async () => {
              const v = await promptDialog({
                title: "Accept predicted centroids",
                message: "Turn every predicted centroid scoring at least this much into a user centroid, across all frames.",
                defaultValue: "0.5",
                confirmLabel: "Accept",
              });
              if (v === null) return;
              const minScore = Number(v);
              if (!Number.isFinite(minScore)) return void toast.error("Enter a number, e.g. 0.5");
              commandContext.execute(AcceptAllCentroids, { minScore });
            },
          },
          {
            kind: "item",
            id: "labels.centroids.deletePredicted",
            label: "Delete Predicted Centroids...",
            enabled: loaded,
            run: async () => {
              const v = await promptDialog({
                title: "Delete predicted centroids",
                message: "Delete predicted centroids scoring below this, across all frames. Leave it empty to delete every predicted centroid.",
                defaultValue: "0.3",
                confirmLabel: "Delete",
              });
              if (v === null) return;
              const t = v.trim();
              const maxScore = t === "" ? undefined : Number(t);
              if (maxScore !== undefined && !Number.isFinite(maxScore)) return void toast.error("Enter a number, or leave it empty");
              commandContext.execute(DeletePredictedCentroids, { maxScore });
            },
          },
        ],
      },
      SEP,
      // As in PyQt, these need a frame range selected on the seekbar.
      {
        kind: "item",
        id: "labels.extractClip",
        label: "Extract Clip and Labels...",
        enabled: loaded && s.hasFrameRange,
        title: "Export the selected frame range as a trimmed clip plus its labels, renumbered from frame 0, and open it. Select a range by shift-dragging on the seekbar.",
        run: () => store().setExtractClipDialog("clip"),
      },
      {
        kind: "item",
        id: "labels.extractPackage",
        label: "Extract Clip Labels Package...",
        enabled: loaded && s.hasFrameRange,
        title: "Export the selected frame range's labeled and suggested frames, with images embedded, as a .pkg.slp, and open it. Select a range by shift-dragging on the seekbar.",
        run: () => store().setExtractClipDialog("package"),
      },
      SEP,
      { kind: "label", id: "labels.counts", text: `${s.totalLabeled} labeled frames, ${s.totalInstances} instances` },
    ],
  };
}

function predictMenu(s: MenuSnapshot): TopMenu {
  return {
    kind: "menu",
    id: "predict",
    label: "Predict",
    items: [
      // The panel, and its Full Configuration window (opened by the panel).
      { kind: "item", id: "predict.training", label: "Training...", run: () => openWithConfig("training") },
      { kind: "item", id: "predict.inference", label: "Inference / Run Prediction...", run: () => openWithConfig("inference") },
      { kind: "item", id: "predict.connect", label: "Connect (Remote Training / Inference)...", run: () => store().setConnectWindowOpen(true) },
      SEP,
      { kind: "item", id: "predict.exportPackage", label: "Export Labels Package...", enabled: s.projectLoaded, run: () => store().setExportPackageDialogOpen(true) },
      {
        kind: "item",
        id: "predict.exportModel",
        label: "Export Model to ONNX/TensorRT...",
        enabled: s.isTauri,
        title: "Export a trained model to ONNX/TensorRT for faster inference (desktop only)",
        run: () => useExportStore.getState().openExport([]),
      },
      SEP,
      { kind: "item", id: "predict.metrics", label: "Evaluation Metrics for Trained Models...", run: () => store().setModelMetricsDialogOpen(true) },
      {
        kind: "item",
        id: "predict.overlayModels",
        label: "Set Overlay Models…",
        hint: s.overlayModelCount > 0 ? `${s.overlayModelCount} set` : undefined,
        enabled: s.projectLoaded,
        run: () => store().setOverlayModelsDialogOpen(true),
      },
      {
        kind: "check",
        id: "predict.visualizeOutputs",
        label: "Visualize Model Outputs",
        checked: s.overlayModelOutputs,
        enabled: s.projectLoaded && s.overlayModelCount > 0,
        run: () => store().toggle("overlayModelOutputs"),
      },
      {
        kind: "item",
        id: "predict.compareModels",
        label: "Compare Model Predictions…",
        enabled: s.projectLoaded,
        title: "Draw predictions from several models' .slp files over this video, one colour per model",
        run: () => useModelOverlayStore.getState().setDialogOpen(true),
      },
    ],
  };
}

function openWithConfig(panel: "training" | "inference") {
  store().set("configDialogRequest", panel);
  store().openPanel(panel);
}

function tracksMenu(s: MenuSnapshot): TopMenu {
  const hasTracks = s.trackNames.length > 0;
  const items: MenuNode[] = [
    { kind: "item", id: "tracks.transpose", label: "Transpose Instance Tracks", shortcut: "$mod+KeyT", enabled: s.hasInstance, run: () => requestTranspose(commandContext) },
    SEP,
    { kind: "item", id: "tracks.new", label: "New Track", shortcut: "$mod+Digit0", enabled: s.hasInstance, run: exec(AddTrack) },
  ];
  if (hasTracks) {
    items.push({
      kind: "submenu",
      id: "tracks.setTrack",
      label: "Set Instance Track",
      enabled: s.hasInstance,
      scroll: true,
      items: s.trackNames.map((name, idx) => ({
        kind: "item" as const,
        id: `tracks.setTrack.${idx}`,
        label: name,
        shortcut: idx < 9 ? `$mod+Digit${idx + 1}` : undefined,
        run: exec(SetInstanceTrack, { trackIdx: idx }),
      })),
    });
  }
  items.push(
    SEP,
    { kind: "item", id: "tracks.copy", label: "Copy Instance Track", shortcut: "$mod+Shift+KeyC", enabled: s.hasInstance, run: exec(CopyTrack) },
    { kind: "item", id: "tracks.paste", label: "Paste Instance Track", shortcut: "$mod+Shift+KeyV", enabled: s.projectLoaded, run: exec(PasteTrack) },
    SEP,
    { kind: "check", id: "tracks.propagate", label: "Propagate Track Labels", shortcut: DEFAULT_SHORTCUTS["propagate track labels"], checked: s.propagateTrackLabels, run: () => store().toggle("propagateTrackLabels") },
    SEP,
    {
      kind: "item",
      id: "tracks.deleteInstanceAndTrack",
      label: "Delete Instance and Track",
      shortcut: "$mod+Shift+Backspace",
      enabled: s.hasInstance,
      run: async () => {
        if (await confirmDeleteInstanceAndTrack(commandContext.state)) commandContext.execute(DeleteInstanceAndTrack);
      },
    },
    SEP,
  );
  if (hasTracks) {
    items.push({
      kind: "submenu",
      id: "tracks.delete",
      label: "Delete Track",
      enabled: s.projectLoaded,
      scroll: true,
      items: s.trackNames.map((name, idx) => ({
        kind: "item" as const,
        id: `tracks.delete.${idx}`,
        label: name,
        run: async () => {
          const ok = await confirmDialog({
            message: `Delete track "${name}"?`,
            confirmLabel: "Delete",
            destructive: true,
          });
          if (ok) commandContext.execute(DeleteTrack, { trackIdx: idx });
        },
      })),
    });
  }
  items.push(
    {
      kind: "item",
      id: "tracks.deleteUnused",
      label: "Delete Unused Tracks",
      enabled: s.projectLoaded,
      run: async () => {
        if (await confirmDeleteUnusedTracks()) commandContext.execute(DeleteUnusedTracks);
      },
    },
    {
      kind: "item",
      id: "tracks.deleteAll",
      label: "Delete All Tracks",
      enabled: s.projectLoaded,
      run: async () => {
        const ok = await confirmDialog({
          message: "Delete ALL tracks? Every instance will be left untracked.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (ok) commandContext.execute(DeleteAllTracks);
      },
    },
    SEP,
    // Seekbar Header graph picker (PyQt: Tracks → Seekbar Header). Two-way
    // synced with the picker button next to the scrubbar — both read/write the
    // same `seekbarHeaderGraph` store field. min/max stay on that button's
    // reduction selector, so only base graphs are listed here.
    {
      kind: "submenu",
      id: "tracks.seekbarHeader",
      label: "Seekbar Header",
      enabled: s.projectLoaded,
      items: [
        radio(
          "tracks.seekbarHeader.value",
          s.seekbarHeaderGraph,
          GRAPH_SPECS.map((spec) => [spec.type, spec.label]),
          (val) => {
            const next = val as StatisticGraphType;
            const st = store();
            st.set("seekbarHeaderGraph", next);
            const r = reconcileReduction(next, st.seekbarHeaderReduction as Reduction);
            if (r !== st.seekbarHeaderReduction) st.set("seekbarHeaderReduction", r);
          },
        ),
      ],
    },
  );
  return { kind: "menu", id: "tracks", label: "Tracks", items };
}

function analyzeMenu(s: MenuSnapshot): TopMenu {
  return {
    kind: "menu",
    id: "analyze",
    label: "Analyze",
    items: [
      { kind: "item", id: "analyze.sizeDistribution", label: "Instance Size Distribution…", enabled: s.projectLoaded, run: () => store().setSizeDistributionDialogOpen(true) },
      { kind: "item", id: "analyze.labelQc", label: "Label Quality Check…", enabled: s.projectLoaded, run: () => store().setLabelQcDialogOpen(true) },
    ],
  };
}

function helpMenu(s: MenuSnapshot): TopMenu {
  return {
    kind: "menu",
    id: "help",
    label: "Help",
    items: [
      { kind: "item", id: "help.docs", label: "Documentation", run: () => openExternal(getDocsUrl()) },
      { kind: "item", id: "help.tutorial", label: "Start Tutorial", run: () => void requestStartTutorial() },
      { kind: "item", id: "help.labelingTips", label: "Labeling Tips...", run: () => store().setLabelingTipsDialogOpen(true) },
      { kind: "check", id: "help.hints", label: "Show Hints During Labeling", checked: s.showLabelingHints, run: () => store().toggle("showLabelingHints") },
      SEP,
      { kind: "item", id: "help.searchMenus", label: "Search Menus...", run: () => store().setMenuSearchDialogOpen(true) },
      { kind: "item", id: "help.shortcuts", label: "Keyboard Shortcuts...", run: () => store().setShortcutsDialogOpen(true) },
      SEP,
      { kind: "item", id: "help.whatsNew", label: "New in SLEAP App", run: () => openExternal(`${getDocsUrl()}whats-new/`) },
      { kind: "item", id: "help.reportIssue", label: "Report Issue", run: () => openExternal("https://github.com/talmolab/sleap-app/issues") },
      { kind: "item", id: "help.diagnostics", label: "Collect Diagnostics...", run: () => store().setDiagnosticsDialogOpen(true) },
      { kind: "item", id: "help.releases", label: "Releases", run: () => openExternal("https://github.com/talmolab/sleap-app/releases") },
      SEP,
      // PyQt SLEAP's Help ▸ "Share usage data" toggle. Choosing either way is
      // an explicit choice, so it also retires the first-run notice.
      {
        kind: "check",
        id: "help.shareUsageData",
        label: "Share Usage Data",
        title: "Send feature usage and error reports to the SLEAP team. Never videos, labels or file names.",
        checked: s.shareUsageData,
        run: () => {
          store().set("shareUsageData", !usageDataEnabled(store().shareUsageData));
          store().set("usageDataNoticeSeen", true);
        },
      },
      { kind: "item", id: "help.usageData", label: "About Usage Data", run: () => openExternal(`${getDocsUrl()}usage-data/`) },
      SEP,
      { kind: "item", id: "help.about", label: "About SLEAP Label", run: () => store().setHelpDialogOpen(true) },
    ],
  };
}

/**
 * Count each menu item as it runs. Done here, on the one definition, so the
 * in-window bar, the native menu and Search Menus are all covered without any
 * of them knowing; `countMenu` is a no-op unless usage sharing is on.
 */
function countingUsage<T extends MenuNode | TopAction>(node: T): T {
  switch (node.kind) {
    case "item":
    case "check":
    case "action":
      return {
        ...node,
        run: () => {
          countMenu(node.id);
          return node.run();
        },
      };
    case "radio":
      return {
        ...node,
        select: (value: string) => {
          countMenu(node.id);
          node.select(value);
        },
      };
    case "submenu":
      return { ...node, items: node.items.map(countingUsage) };
    default:
      return node;
  }
}

export function buildAppMenu(s: MenuSnapshot): AppMenu {
  return menuDefinition(s).map((top) =>
    top.kind === "menu" ? { ...top, items: top.items.map(countingUsage) } : countingUsage(top),
  );
}

function menuDefinition(s: MenuSnapshot): AppMenu {
  return [
    // The order of PyQt SLEAP's menus.
    fileMenu(s),
    goMenu(s),
    viewMenu(s),
    labelsMenu(s),
    analyzeMenu(s),
    tracksMenu(s),
    predictMenu(s),
    helpMenu(s),
  ];
}
