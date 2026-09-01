/**
 * Application menu bar.
 *
 * Renders a desktop-style menu bar with File, Edit, Go, View, Labels, Predict, Tracks, Help menus.
 * All actions are wired to the command system via CommandContext.
 */

import { useAppStore, type NavigationDomain } from "../../stores/appStore";
import { PANELS } from "./panelRegistry";
import { isTauri } from "../../lib/platform";
import { APP_VERSION, APP_VERSION_KIND_LABEL } from "@/lib/version";
import { formatShortcut } from "@/lib/formatShortcut";

async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}
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
  AddInstance,
  ToggleNegativeFrame,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  DeleteFramePredictions,
  DeleteAllPredictions,
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
} from "../../commands";
import { PALETTES } from "../../lib/colorPalettes";
import { QC_MODE_CHOICES } from "../../lib/instanceVisibility";
import { toast } from "@/lib/notify";
import { humanizeCommandName } from "@/lib/humanizeCommand";
import { sleapCmd } from "@/lib/sleapPlugin";
import { openNewInstance } from "@/lib/newInstance";
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarCheckboxItem,
  MenubarShortcut,
  MenubarLabel,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
  MenubarRadioGroup,
  MenubarRadioItem,
} from "@/components/ui/menubar";
import { Button } from "@/components/ui/button";
import {
  GRAPH_SPECS,
  reconcileReduction,
  type StatisticGraphType,
  type Reduction,
} from "@/lib/statisticSeries";

export function MenuBar() {
  return (
    <Menubar
      className={`h-8 rounded-none border-0 border-b border-border bg-card pr-0 gap-0 shadow-none ${
        // Web deployments have no OS title bar to carry the app's identity, so
        // show a SLEAP icon + wordmark on the left. The desktop (Tauri) build
        // already has a native title bar showing "SLEAP", so it's hidden there
        // to avoid the redundancy that removed it originally (#133 / #142).
        isTauri ? "pl-2" : "pl-0"
      }`}
    >
      {!isTauri && (
        <div className="flex items-baseline gap-1.5 px-3 text-sm font-semibold tracking-wider text-primary select-none">
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt=""
            className="h-4 w-4 self-center"
          />
          <span>SLEAP</span>
          {/* The desktop shell gets its version from the native title bar
              ("SLEAP v1.2.3"), which the web has no equivalent of -- a browser
              tab title is usually truncated to the point of being unreadable.
              So carry it here instead, in the block that exists for exactly
              this reason (#133 / #142). Same @/lib/version source as the title
              and the About dialog, so a deployed path can't misreport itself.
              `title` spells out the channel wording rather than crowding the
              bar with it. */}
          <span
            className="text-[10px] font-normal tracking-normal text-muted-foreground"
            title={`SLEAP v${APP_VERSION} — ${APP_VERSION_KIND_LABEL}`}
            data-testid="menubar-version"
          >
            v{APP_VERSION}
          </span>
        </div>
      )}
      <FileMenu />
      <EditMenu />
      <GoMenu />
      <ViewMenu />
      <PanelsMenu />
      <LabelsMenu />
      <PredictMenu />
      <TracksMenu />
      <AnalyzeMenu />
      <Button
        variant="ghost"
        size="sm"
        className="h-8 rounded-none px-3 text-xs font-normal"
        onClick={() => useAppStore.getState().startTutorial()}
      >
        Start Tutorial
      </Button>
      <HelpMenu />
    </Menubar>
  );
}

function AnalyzeMenu() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const setSizeDistributionDialogOpen = useAppStore(
    (s) => s.setSizeDistributionDialogOpen
  );
  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Analyze</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => setSizeDistributionDialogOpen(true)}
        >
          Instance Size Distribution…
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function FileMenu() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const labels = useAppStore((s) => s.labels);
  const projectPath = useAppStore((s) => s.projectPath);

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  return (
    <MenubarMenu>
      <MenubarTrigger
        className="px-3 h-8 text-xs rounded-none"
        data-tutorial="file-menu-trigger"
      >
        File
      </MenubarTrigger>
      <MenubarContent>
        <MenubarItem onClick={() => void openNewInstance()}>
          New Project... <MenubarShortcut>{formatShortcut("$mod+KeyN")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onClick={() => exec(OpenProjectCommand)}>
          Open Project... <MenubarShortcut>{formatShortcut("$mod+KeyO")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSub>
          <MenubarSubTrigger>Import</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onClick={() => exec(ImportAnalysisH5Command)}>
              Analysis HDF5...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ImportNwbCommand)}>
              NWB dataset...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ImportCocoCommand)}>
              COCO dataset...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ImportDlcCommand)}>
              DeepLabCut dataset...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ImportDlcFolderCommand)}>
              Multiple DeepLabCut datasets from folder...
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().setMergeProjectDialogOpen(true)}
        >
          Merge into Project...
        </MenubarItem>
        <MenubarSub>
          <MenubarSubTrigger disabled={!projectLoaded}>Replace Videos...</MenubarSubTrigger>
          <MenubarSubContent>
            {/* Bounded, scrollable so projects with many videos don't overflow
                the screen (the sub-content itself is overflow-hidden). */}
            <div className="max-h-[60vh] overflow-y-auto">
              {labels?.videos.map((v, idx) => (
                <MenubarItem
                  key={idx}
                  onClick={async () => {
                    const { resolveVideoFile } = await import("../../lib/resolveVideos");
                    const ok = await resolveVideoFile(v, labels ?? undefined);
                    useAppStore.getState().bumpOverlayVersion();
                    // Re-read the now-known shape so the seekbar/status bar
                    // re-extend the timeline to the full video (videoRevision
                    // is the memo dep; a bare in-place shape set won't trigger).
                    if (ok) useAppStore.getState().markVideoUpdated();
                  }}
                >
                  {(Array.isArray(v.filename) ? v.filename[0] : v.filename)?.split("/").pop() || `Video ${idx + 1}`}
                </MenubarItem>
              ))}
            </div>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() =>
            useAppStore.getState().setAddVideoUrlDialogOpen(true)
          }
        >
          Add Video from URL...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(SaveProjectCommand)}
        >
          Save <MenubarShortcut>{formatShortcut("$mod+KeyS")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(SaveAsProjectCommand)}
        >
          Save As... <MenubarShortcut>{formatShortcut("$mod+Shift+KeyS")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger disabled={!projectLoaded}>
            Export
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onClick={() => exec(ExportJsonCommand)}>
              JSON...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ExportCSVCommand)}>
              Analysis CSV...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ExportAnalysisH5Command)}>
              Analysis HDF5...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ExportNwbCommand)}>
              NWB (ndx-pose)...
            </MenubarItem>
            <MenubarItem onClick={() => exec(ExportPackageCommand)}>
              Labels Package...
            </MenubarItem>
            <MenubarItem
              onClick={() =>
                useAppStore.getState().setExportClipDialogOpen(true)
              }
            >
              Labeled Clip (Video)...
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>
        {isTauri && (
          <>
            <MenubarSeparator />
            <MenubarItem
              disabled={!projectPath}
              onClick={async () => {
                if (!projectPath) return;
                const { invoke } = await import("@tauri-apps/api/core");
                try {
                  await invoke(sleapCmd("reveal_in_file_manager"), {
                    path: projectPath,
                  });
                } catch (e) {
                  const { toast } = await import("@/lib/notify");
                  toast.error("Failed to reveal project file", {
                    description: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            >
              Reveal Project in File Manager
            </MenubarItem>
            <MenubarItem
              onClick={async () => {
                const { invoke } = await import("@tauri-apps/api/core");
                try {
                  await invoke(sleapCmd("open_preferences_directory"));
                } catch (e) {
                  const { toast } = await import("@/lib/notify");
                  toast.error("Failed to open preferences directory", {
                    description: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            >
              Open Preferences Directory...
            </MenubarItem>
            <MenubarItem
              onClick={async () => {
                const { toast } = await import("@/lib/notify");
                const {
                  videoTranscodeCacheInfo,
                  clearVideoTranscodeCache,
                  backendKindForFilename,
                  getBasename,
                } = await import("@/lib/resolveVideos");
                const { isTranscodeCached } = await import(
                  "@/lib/transcode/transcodeVideo"
                );
                const { createTauriTranscodeDeps } = await import(
                  "@/lib/transcode/transcodeDepsTauri"
                );
                const mb = (b: number) => (b / 1_000_000).toFixed(1);
                try {
                  const info = await videoTranscodeCacheInfo();
                  if (info.count === 0) {
                    toast.info("No transcoded videos to clear");
                    return;
                  }
                  const plural = info.count > 1 ? "s" : "";
                  // Legacy-container videos currently OPEN whose transcode is in the
                  // cache — clearing now breaks their view until Replace Video /
                  // reopen. (H.264/MJPEG AVIs decode directly → no cache entry → not
                  // flagged.) Checks the cache file, not the backend class name, so
                  // it stays correct in a minified build.
                  const deps = createTauriTranscodeDeps();
                  const inUse: string[] = [];
                  for (const v of useAppStore.getState().labels?.videos ?? []) {
                    const name = Array.isArray(v.filename)
                      ? v.filename[0] ?? ""
                      : v.filename;
                    if (!v.backend || backendKindForFilename(name) !== "avi")
                      continue;
                    try {
                      if (await isTranscodeCached(name, deps))
                        inUse.push(getBasename(name));
                    } catch {
                      /* stat failed — skip */
                    }
                  }
                  const inUseWarning =
                    inUse.length > 0
                      ? `⚠ ${inUse.length} open video${inUse.length > 1 ? "s" : ""} ` +
                        `(${inUse.join(", ")}) ${inUse.length > 1 ? "are" : "is"} using a converted copy right now. ` +
                        `Clearing will make ${inUse.length > 1 ? "them" : "it"} show ` +
                        "“frame image not found” until you re-convert via Replace Video " +
                        "(or reopen the project).\n\n"
                      : "";
                  // In-app styled confirm — NOT window.confirm or a native OS
                  // dialog (both broken/inconsistent in the Tauri WebView); this
                  // matches the app's look and works in browser + desktop.
                  const { confirmDialog } = await import("@/stores/confirmStore");
                  const proceed = await confirmDialog({
                    title: "Clear video transcode cache",
                    message:
                      inUseWarning +
                      `Clear ${info.count} transcoded video${plural} (${mb(info.bytes)} MB)?\n\n` +
                      "These legacy-format conversions are re-created automatically " +
                      "the next time you open the original files.",
                    confirmLabel: "Clear",
                    cancelLabel: "Cancel",
                    destructive: true,
                  });
                  if (!proceed) return;
                  const freed = await clearVideoTranscodeCache();
                  toast.success(
                    `Cleared ${freed.count} transcoded video${freed.count > 1 ? "s" : ""} (${mb(freed.bytes)} MB)`
                  );
                } catch (e) {
                  toast.error("Failed to clear transcode cache", {
                    description: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
            >
              Clear Video Transcode Cache...
            </MenubarItem>
          </>
        )}
        <MenubarSeparator />
        <MenubarItem
          onClick={async () => {
            const { quitApp } = await import("../../lib/quit");
            await quitApp();
          }}
        >
          Quit <MenubarShortcut>{formatShortcut("$mod+KeyQ")}</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function EditMenu() {
  // Subscribe to reactive state so undo/redo labels update
  useAppStore((s) => s.labeledFrame);
  useAppStore((s) => s.hasChanges);

  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const instance = useAppStore((s) => s.instance);
  const clipboardInstance = useAppStore((s) => s.clipboardInstance);
  // Instances require a skeleton with at least one node (a node-less skeleton
  // would yield a null instance). overlayVersion is bumped on node changes.
  useAppStore((s) => s.overlayVersion);
  const skeletonHasNodes = useAppStore((s) => (s.skeleton?.nodes?.length ?? 0) > 0);

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  const canUndo = commandContext.canUndo;
  const canRedo = commandContext.canRedo;
  const undoLabel = canUndo
    ? `Undo ${humanizeCommandName(commandContext.undoCommandName ?? "")}`
    : "Undo";
  const redoLabel = canRedo
    ? `Redo ${humanizeCommandName(commandContext.redoCommandName ?? "")}`
    : "Redo";

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Edit</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!canUndo}
          onClick={() => commandContext.undo()}
        >
          {undoLabel} <MenubarShortcut>{formatShortcut("$mod+KeyZ")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!canRedo}
          onClick={() => commandContext.redo()}
        >
          {redoLabel} <MenubarShortcut>{formatShortcut("$mod+Shift+KeyZ")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            exec(CopyInstance);
            toast.info("Instance copied");
          }}
        >
          Copy Instance <MenubarShortcut>{formatShortcut("$mod+KeyC")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!clipboardInstance || !skeletonHasNodes}
          onClick={() => {
            exec(PasteInstance);
            toast.info("Instance pasted");
          }}
        >
          Paste Instance <MenubarShortcut>{formatShortcut("$mod+KeyV")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded || !skeletonHasNodes}
          onClick={() => exec(AddInstance)}
        >
          Add Instance <MenubarShortcut>{formatShortcut("$mod+KeyI")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            exec(DeleteSelectedInstance);
            toast.info("Instance deleted");
          }}
        >
          Delete Instance <MenubarShortcut>{formatShortcut("$mod+Backspace")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(DeleteFramePredictions)}
        >
          Delete Predictions on Current Frame
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function GoMenu() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const navigationDomain = useAppStore((s) => s.navigationDomain);
  const setNavigationDomain = useAppStore((s) => s.setNavigationDomain);

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Go</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().setGoToFrameDialogOpen(true)}
        >
          Go to Frame... <MenubarShortcut>{formatShortcut("$mod+KeyJ")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().setSelectToFrameDialogOpen(true)}
        >
          Select to Frame... <MenubarShortcut>{formatShortcut("$mod+Shift+KeyJ")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextLabeledFrame)}>
          Next Labeled Frame <MenubarShortcut>{formatShortcut("Alt+ArrowRight")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoPrevLabeledFrame)}>
          Previous Labeled Frame <MenubarShortcut>{formatShortcut("Alt+ArrowLeft")}</MenubarShortcut>
        </MenubarItem>
        <MenubarRadioGroup
          value={navigationDomain}
          onValueChange={(v) => setNavigationDomain(v as NavigationDomain)}
        >
          <MenubarRadioItem value="all" disabled={!projectLoaded}>
            Navigate All Frames
          </MenubarRadioItem>
          <MenubarRadioItem value="labeled" disabled={!projectLoaded}>
            Navigate Labeled Frames Only
          </MenubarRadioItem>
          <MenubarRadioItem value="imaged" disabled={!projectLoaded}>
            Navigate Imaged Frames Only
          </MenubarRadioItem>
        </MenubarRadioGroup>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextSuggestion)}>
          Next Suggestion <MenubarShortcut>Space</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoPrevSuggestion)}>
          Previous Suggestion <MenubarShortcut>{formatShortcut("Shift+Space")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoToLastInteracted)}>
          Last Interacted Frame <MenubarShortcut>{formatShortcut("$mod+KeyA")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextUserFrame)}>
          Next User Labeled Frame <MenubarShortcut>{formatShortcut("$mod+KeyU")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoPrevUserFrame)}>
          Previous User Labeled Frame <MenubarShortcut>{formatShortcut("$mod+Shift+KeyU")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextTrackSpawnFrame)}>
          Next Track Spawn Frame <MenubarShortcut>{formatShortcut("$mod+KeyE")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            const s = useAppStore.getState();
            if (s.video) s.setMarkedFrame({ video: s.video, frameIdx: s.frameIdx });
          }}
        >
          Mark Frame <MenubarShortcut>{formatShortcut("$mod+KeyM")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoToMarkedFrame)}>
          Go to Marked Frame <MenubarShortcut>{formatShortcut("$mod+Shift+KeyM")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            const { labels, video } = useAppStore.getState();
            if (!labels || !video) return;
            const idx = labels.videos.indexOf(video);
            const next = labels.videos[(idx + 1) % labels.videos.length];
            if (next) useAppStore.getState().setVideo(next);
          }}
        >
          Next Video <MenubarShortcut>{formatShortcut("Alt+Shift+ArrowRight")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            const { labels, video } = useAppStore.getState();
            if (!labels || !video) return;
            const idx = labels.videos.indexOf(video);
            const prev =
              labels.videos[(idx - 1 + labels.videos.length) % labels.videos.length];
            if (prev) useAppStore.getState().setVideo(prev);
          }}
        >
          Previous Video <MenubarShortcut>{formatShortcut("Alt+Shift+ArrowLeft")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            const { labeledFrame, instance } = useAppStore.getState();
            if (!labeledFrame) return;
            const instances = labeledFrame.instances;
            if (instances.length === 0) return;
            if (!instance) {
              useAppStore.getState().setInstance(instances[0]);
            } else {
              const idx = instances.indexOf(instance);
              useAppStore
                .getState()
                .setInstance(instances[(idx + 1) % instances.length]);
            }
          }}
        >
          Select Next Instance <MenubarShortcut>`</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().setInstance(null)}
        >
          Clear Selection <MenubarShortcut>Esc</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function ViewMenu() {
  const showInstances = useAppStore((s) => s.showInstances);
  const showLabels = useAppStore((s) => s.showLabels);
  const showEdges = useAppStore((s) => s.showEdges);
  const showNonVisibleNodes = useAppStore((s) => s.showNonVisibleNodes);
  const showInset = useAppStore((s) => s.showInset);
  const colorPredicted = useAppStore((s) => s.colorPredicted);
  const showTrackScore = useAppStore((s) => s.showTrackScore);
  const fit = useAppStore((s) => s.fit);
  const edgeStyle = useAppStore((s) => s.edgeStyle);
  const markerSize = useAppStore((s) => s.markerSize);
  const nodeLabelSize = useAppStore((s) => s.nodeLabelSize);
  const palette = useAppStore((s) => s.palette);
  const trailLength = useAppStore((s) => s.trailLength);
  const distinctlyColor = useAppStore((s) => s.distinctlyColor);
  const defaultToPan = useAppStore((s) => s.defaultToPan);
  const labelingMode = useAppStore((s) => s.labelingMode);
  const instance = useAppStore((s) => s.instance);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarSide = useAppStore((s) => s.sidebarSide);
  const sidebarMultiPanel = useAppStore((s) => s.sidebarMultiPanel);
  const setSidebarMultiPanel = useAppStore((s) => s.setSidebarMultiPanel);
  const showCrosshair = useAppStore((s) => s.showCrosshair);
  const uiScale = useAppStore((s) => s.uiScale);
  const qcDisplayMode = useAppStore((s) => s.qcDisplayMode);
  const setQcDisplayMode = useAppStore((s) => s.setQcDisplayMode);
  const toggle = useAppStore((s) => s.toggle);
  const setVal = useAppStore((s) => s.set);

  const adjustScale = (delta: number) => {
    const newScale = Math.max(0.75, Math.min(1.5, uiScale + delta));
    setVal("uiScale", Math.round(newScale * 100) / 100);
    document.documentElement.style.setProperty("--ui-scale", String(newScale));
  };

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">View</MenubarTrigger>
      <MenubarContent>
        <MenubarCheckboxItem
          checked={!sidebarCollapsed}
          onCheckedChange={() => toggle("sidebarCollapsed")}
        >
          Side Panel
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={sidebarSide === "left"}
          onCheckedChange={(c) => setVal("sidebarSide", c ? "left" : "right")}
        >
          Sidebar on Left
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={sidebarMultiPanel}
          onCheckedChange={(c) => setSidebarMultiPanel(c === true)}
        >
          Allow Multiple Panels
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={fit}
          onCheckedChange={() => toggle("fit")}
        >
          Fit View to Instances
        </MenubarCheckboxItem>
        <MenubarItem
          disabled={!instance}
          onClick={() => useAppStore.getState().set("fitSelection", true)}
        >
          Fit View to Selection
        </MenubarItem>
        <MenubarCheckboxItem
          checked={defaultToPan}
          onCheckedChange={() => toggle("defaultToPan")}
        >
          Default to Pan Mode <MenubarShortcut>P</MenubarShortcut>
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={labelingMode === "place"}
          disabled={!instance && labelingMode !== "place"}
          onCheckedChange={() => {
            const s = useAppStore.getState();
            if (s.labelingMode === "place") {
              s.exitPlacementMode();
            } else if (s.instance) {
              s.enterPlacementMode();
            }
          }}
        >
          Node Placement Mode <MenubarShortcut>N</MenubarShortcut>
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Text Size</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarItem onClick={() => adjustScale(0.05)}>
              Increase <MenubarShortcut>{formatShortcut("$mod+Shift+Equal")}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => adjustScale(-0.05)}>
              Decrease <MenubarShortcut>{formatShortcut("$mod+Minus")}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => {
              setVal("uiScale", 1);
              document.documentElement.style.setProperty("--ui-scale", "1");
            }}>
              Reset to Default
            </MenubarItem>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarCheckboxItem
          checked={showInstances}
          onCheckedChange={() => toggle("showInstances")}
        >
          Show Instances
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={showNonVisibleNodes}
          onCheckedChange={() => toggle("showNonVisibleNodes")}
        >
          Show Non-Visible Nodes <MenubarShortcut>V</MenubarShortcut>
        </MenubarCheckboxItem>
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Display</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={qcDisplayMode}
              onValueChange={(v) => setQcDisplayMode(v as typeof qcDisplayMode)}
            >
              {QC_MODE_CHOICES.map(([label, mode]) => (
                <MenubarRadioItem key={mode} value={mode}>
                  {label}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarCheckboxItem
          checked={showLabels}
          onCheckedChange={() => toggle("showLabels")}
        >
          Show Node Names
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={showEdges}
          onCheckedChange={() => toggle("showEdges")}
        >
          Show Edges
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={showCrosshair}
          onCheckedChange={() => toggle("showCrosshair")}
        >
          Crosshair When Zoomed
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={showInset}
          onCheckedChange={() => toggle("showInset")}
        >
          Magnifier When Moving Nodes
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Edge Style</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={edgeStyle}
              onValueChange={(val) => setVal("edgeStyle", val as "Line" | "Wedge")}
            >
              <MenubarRadioItem value="Line">Line</MenubarRadioItem>
              <MenubarRadioItem value="Wedge">Wedge</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Node Marker Size</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={String(markerSize)}
              onValueChange={(val) => setVal("markerSize", Number(val))}
            >
              <MenubarRadioItem value="2">Small (2)</MenubarRadioItem>
              <MenubarRadioItem value="4">Medium (4)</MenubarRadioItem>
              <MenubarRadioItem value="6">Large (6)</MenubarRadioItem>
              <MenubarRadioItem value="8">Extra Large (8)</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Node Label Size</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={String(nodeLabelSize)}
              onValueChange={(val) => setVal("nodeLabelSize", Number(val))}
            >
              <MenubarRadioItem value="8">Small (8)</MenubarRadioItem>
              <MenubarRadioItem value="10">Medium (10)</MenubarRadioItem>
              <MenubarRadioItem value="12">Large (12)</MenubarRadioItem>
              <MenubarRadioItem value="14">Extra Large (14)</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Trail Length</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={String(trailLength)}
              onValueChange={(val) => setVal("trailLength", Number(val))}
            >
              <MenubarRadioItem value="0">Off</MenubarRadioItem>
              <MenubarRadioItem value="10">Short (10)</MenubarRadioItem>
              <MenubarRadioItem value="50">Medium (50)</MenubarRadioItem>
              <MenubarRadioItem value="100">Long (100)</MenubarRadioItem>
              <MenubarRadioItem value="250">Very Long (250)</MenubarRadioItem>
              <MenubarRadioItem value="500">Maximum (500)</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Color Palette</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={palette}
              onValueChange={(val) => setVal("palette", val)}
            >
              {Object.keys(PALETTES).map((name) => (
                <MenubarRadioItem key={name} value={name}>
                  {name}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarSub>
          <MenubarSubTrigger className="text-sm">Apply Distinct Colors To</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={distinctlyColor}
              onValueChange={(val) => setVal("distinctlyColor", val as "auto" | "track" | "instance" | "node" | "edge")}
            >
              <MenubarRadioItem value="auto">Auto (Node / Track)</MenubarRadioItem>
              <MenubarRadioItem value="track">Tracks</MenubarRadioItem>
              <MenubarRadioItem value="instance">Instances</MenubarRadioItem>
              <MenubarRadioItem value="node">Nodes</MenubarRadioItem>
              <MenubarRadioItem value="edge">Edges</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarCheckboxItem
          checked={colorPredicted}
          onCheckedChange={() => toggle("colorPredicted")}
        >
          Color Predicted Instances
        </MenubarCheckboxItem>
        <MenubarCheckboxItem
          checked={showTrackScore}
          onCheckedChange={() => toggle("showTrackScore")}
        >
          Show Track Scores
        </MenubarCheckboxItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

/** Curate which panels appear in the right sidebar strip (#135). */
function PanelsMenu() {
  const hiddenPanels = useAppStore((s) => s.hiddenPanels);
  const togglePanelVisibility = useAppStore((s) => s.togglePanelVisibility);

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Panels</MenubarTrigger>
      <MenubarContent>
        {PANELS.map((panel) => (
          <MenubarCheckboxItem
            key={panel.id}
            checked={!hiddenPanels.includes(panel.id)}
            // Keep the menu open so several panels can be toggled in one trip.
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => togglePanelVisibility(panel.id)}
          >
            {panel.label}
          </MenubarCheckboxItem>
        ))}
        <MenubarSeparator />
        <MenubarItem
          onClick={async () => {
            const { confirmDialog } = await import("@/stores/confirmStore");
            if (
              await confirmDialog({
                message: "Reset panels to their default order and visibility?",
              })
            ) {
              useAppStore.getState().resetPanels();
            }
          }}
        >
          Reset to Defaults...
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function LabelsMenu() {
  const labels = useAppStore((s) => s.labels);
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const instance = useAppStore((s) => s.instance);
  const labeledFrame = useAppStore((s) => s.labeledFrame);
  const instanceInitMethod = useAppStore((s) => s.instanceInitMethod);
  const showLabelingHints = useAppStore((s) => s.showLabelingHints);
  // Instances require a skeleton with at least one node (see EditMenu).
  useAppStore((s) => s.overlayVersion);
  const skeletonHasNodes = useAppStore((s) => (s.skeleton?.nodes?.length ?? 0) > 0);
  const totalLabeled = labels?.labeledFrames.length ?? 0;
  const totalInstances =
    labels?.labeledFrames.reduce((sum, lf) => sum + lf.instances.length, 0) ?? 0;

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Labels</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!projectLoaded || !skeletonHasNodes}
          onClick={() => exec(AddInstance)}
        >
          Add Instance <MenubarShortcut>{formatShortcut("$mod+KeyI")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSub>
          <MenubarSubTrigger>Instance Placement Method</MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={instanceInitMethod}
              onValueChange={(v) => useAppStore.getState().set("instanceInitMethod", v as typeof instanceInitMethod)}
            >
              <MenubarRadioItem value="best">Best</MenubarRadioItem>
              <MenubarRadioItem value="template">Template</MenubarRadioItem>
              <MenubarRadioItem value="force_directed">Force Directed</MenubarRadioItem>
              <MenubarRadioItem value="random">Random</MenubarRadioItem>
              <MenubarRadioItem value="prior_frame">Copy Prior Frame</MenubarRadioItem>
              <MenubarRadioItem value="prediction">Copy Predictions</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
        <MenubarCheckboxItem
          checked={showLabelingHints}
          onCheckedChange={() => useAppStore.getState().toggle("showLabelingHints")}
        >
          Show Hints During Labeling
        </MenubarCheckboxItem>
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(DeleteSelectedInstance)}
        >
          Delete Instance <MenubarShortcut>{formatShortcut("$mod+Backspace")}</MenubarShortcut>
        </MenubarItem>
        <MenubarCheckboxItem
          disabled={!projectLoaded}
          checked={labeledFrame?.isNegative ?? false}
          onClick={() => exec(ToggleNegativeFrame)}
        >
          Mark Frame as Negative
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(AddInstancesFromAllPredictions)}
        >
          Accept All Predictions on Current Frame
          <MenubarShortcut>{formatShortcut("$mod+Shift+KeyA")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(AddInstancesFromAllPredictionsInProject)}
        >
          Accept All Predictions
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(DeleteFramePredictions)}
        >
          Delete Predictions on Current Frame
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() =>
            useAppStore.getState().setDeletePredictionsDialogOpen(true)
          }
        >
          Delete Predictions...
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().toggle("areaDeleteMode")}
        >
          Delete Predictions from Area... <MenubarShortcut>{formatShortcut("$mod+KeyK")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            if (confirm("Delete all predicted instances across all frames?")) {
              exec(DeleteAllPredictions);
              toast.info("All predictions deleted");
            }
          }}
        >
          Delete All Predictions...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarLabel className="text-xs text-muted-foreground font-normal">
          {totalLabeled} labeled frames, {totalInstances} instances
        </MenubarLabel>
      </MenubarContent>
    </MenubarMenu>
  );
}

function PredictMenu() {
  const openPanel = useAppStore((s) => s.openPanel);
  const setModelMetricsDialogOpen = useAppStore(
    (s) => s.setModelMetricsDialogOpen
  );
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const setExportPackageDialogOpen = useAppStore(
    (s) => s.setExportPackageDialogOpen
  );

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Predict</MenubarTrigger>
      <MenubarContent>
        <MenubarItem onClick={() => openPanel("training")}>
          Training...
        </MenubarItem>
        <MenubarItem onClick={() => openPanel("inference")}>
          Inference / Run Prediction...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => setExportPackageDialogOpen(true)}
        >
          Export Labels Package...
        </MenubarItem>
        <MenubarItem
          onClick={() =>
            alert(
              "Import Predictions is not yet implemented.\n\nUse File > Open Project to load an SLP file containing predictions."
            )
          }
        >
          Import Predictions...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem onClick={() => setModelMetricsDialogOpen(true)}>
          Evaluation Metrics for Trained Models...
        </MenubarItem>
        <MenubarItem disabled>
          Visualize Model Outputs...
          <MenubarShortcut className="text-xs opacity-60">Coming Soon</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}

function TracksMenu() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const instance = useAppStore((s) => s.instance);
  const labels = useAppStore((s) => s.labels);
  const seekbarHeaderGraph = useAppStore((s) => s.seekbarHeaderGraph);
  const propagateTrackLabels = useAppStore((s) => s.propagateTrackLabels);
  const toggle = useAppStore((s) => s.toggle);

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Tracks</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!instance}
          onClick={() => requestTranspose(commandContext)}
        >
          Transpose Instance Tracks <MenubarShortcut>{formatShortcut("$mod+KeyT")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(AddTrack)}
        >
          New Track <MenubarShortcut>{formatShortcut("$mod+Digit0")}</MenubarShortcut>
        </MenubarItem>
        {labels?.tracks && labels.tracks.length > 0 && (
          <MenubarSub>
            <MenubarSubTrigger disabled={!instance}>Set Instance Track</MenubarSubTrigger>
            <MenubarSubContent>
              {/* Bounded, scrollable so projects with many tracks don't overflow
                  the screen (the sub-content itself is overflow-hidden). */}
              <div className="max-h-[60vh] overflow-y-auto">
                {labels.tracks.map((track, idx) => (
                  <MenubarItem key={idx} onClick={() => commandContext.execute(SetInstanceTrack, { trackIdx: idx })}>
                    {track.name} {idx < 9 && <MenubarShortcut>{formatShortcut(`$mod+Digit${idx + 1}`)}</MenubarShortcut>}
                  </MenubarItem>
                ))}
              </div>
            </MenubarSubContent>
          </MenubarSub>
        )}
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(CopyTrack)}
        >
          Copy Instance Track <MenubarShortcut>{formatShortcut("$mod+Shift+KeyC")}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(PasteTrack)}
        >
          Paste Instance Track <MenubarShortcut>{formatShortcut("$mod+Shift+KeyV")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarCheckboxItem
          checked={propagateTrackLabels}
          onCheckedChange={() => toggle("propagateTrackLabels")}
        >
          Propagate Track Labels
        </MenubarCheckboxItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            if (confirm("Delete this instance and its track?"))
              exec(DeleteInstanceAndTrack);
          }}
        >
          Delete Instance and Track <MenubarShortcut>{formatShortcut("$mod+Shift+Backspace")}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        {labels?.tracks && labels.tracks.length > 0 && (
          <MenubarSub>
            <MenubarSubTrigger disabled={!projectLoaded}>Delete Track</MenubarSubTrigger>
            <MenubarSubContent>
              {/* Bounded, scrollable so projects with many tracks don't overflow
                  the screen (the sub-content itself is overflow-hidden). */}
              <div className="max-h-[60vh] overflow-y-auto">
                {labels.tracks.map((track, idx) => (
                  <MenubarItem
                    key={idx}
                    onClick={() => {
                      if (confirm(`Delete track "${track.name}"?`))
                        commandContext.execute(DeleteTrack, { trackIdx: idx });
                    }}
                  >
                    {track.name}
                  </MenubarItem>
                ))}
              </div>
            </MenubarSubContent>
          </MenubarSub>
        )}
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            if (confirm("Delete all unused tracks?"))
              exec(DeleteUnusedTracks);
          }}
        >
          Delete Unused Tracks
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => {
            if (confirm("Delete ALL tracks?"))
              exec(DeleteAllTracks);
          }}
        >
          Delete All Tracks
        </MenubarItem>
        <MenubarSeparator />
        {/* Seekbar Header graph picker (PyQt: Tracks → Seekbar Header). Two-way
            synced with the picker button next to the scrubbar — both read/write
            the same `seekbarHeaderGraph` store field. min/max stay on that
            button's reduction selector, so only base graphs are listed here. */}
        <MenubarSub>
          <MenubarSubTrigger disabled={!projectLoaded}>
            Seekbar Header
          </MenubarSubTrigger>
          <MenubarSubContent>
            <MenubarRadioGroup
              value={seekbarHeaderGraph}
              onValueChange={(val) => {
                const next = val as StatisticGraphType;
                const store = useAppStore.getState();
                store.set("seekbarHeaderGraph", next);
                const r = reconcileReduction(
                  next,
                  store.seekbarHeaderReduction as Reduction,
                );
                if (r !== store.seekbarHeaderReduction)
                  store.set("seekbarHeaderReduction", r);
              }}
            >
              {GRAPH_SPECS.map((spec) => (
                <MenubarRadioItem key={spec.type} value={spec.type}>
                  {spec.label}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
      </MenubarContent>
    </MenubarMenu>
  );
}

function HelpMenu() {
  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Help</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          onClick={() =>
            useAppStore.getState().setMenuSearchDialogOpen(true)
          }
        >
          Search Menus...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          onClick={() =>
            useAppStore.getState().setShortcutsDialogOpen(true)
          }
        >
          Keyboard Shortcuts...
        </MenubarItem>
        <MenubarItem
          onClick={() =>
            useAppStore.getState().setLabelingTipsDialogOpen(true)
          }
        >
          Labeling Tips...
        </MenubarItem>
        <MenubarItem
          onClick={() => openExternal("https://docs.sleap.ai/")}
        >
          Documentation
        </MenubarItem>
        <MenubarItem
          onClick={() => openExternal("https://github.com/talmolab/sleap-app/issues")}
        >
          Report Issue
        </MenubarItem>
        <MenubarItem
          onClick={() =>
            useAppStore.getState().setDiagnosticsDialogOpen(true)
          }
        >
          Collect Diagnostics...
        </MenubarItem>
        <MenubarItem onClick={() => openExternal("https://github.com/talmolab/sleap-app/releases")}>
          Releases
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          onClick={() => useAppStore.getState().setHelpDialogOpen(true)}
        >
          About SLEAP Label
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
}
