/**
 * Application menu bar.
 *
 * Renders a desktop-style menu bar with File, Edit, Go, View, Labels, Predict, Tracks, Help menus.
 * All actions are wired to the command system via CommandContext.
 */

import { useAppStore } from "../../stores/appStore";
import { modKey, isTauri } from "../../lib/platform";

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
  NewProjectCommand,
  OpenProjectCommand,
  SaveProjectCommand,
  SaveAsProjectCommand,
  ExportJsonCommand,
  ExportCSVCommand,

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
  DeleteAllPredictions,
  AddTrack,
  SetInstanceTrack,
  TransposeInstances,
  CopyTrack,
  PasteTrack,
  PropagateTrackLabels,
  DeleteInstanceAndTrack,
  DeleteTrack,
  DeleteUnusedTracks,
  DeleteAllTracks,
} from "../../commands";
import { PALETTES } from "../../lib/colorPalettes";
import { toast } from "@/lib/notify";
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

export function MenuBar() {
  return (
    <Menubar className="h-8 rounded-none border-0 border-b border-border bg-card pl-2 pr-0 gap-0 shadow-none">
      <FileMenu />
      <EditMenu />
      <GoMenu />
      <ViewMenu />
      <LabelsMenu />
      <PredictMenu />
      <TracksMenu />
      <HelpMenu />
    </Menubar>
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
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">File</MenubarTrigger>
      <MenubarContent>
        <MenubarItem onClick={() => exec(NewProjectCommand)}>
          New Project <MenubarShortcut>{modKey}+N</MenubarShortcut>
        </MenubarItem>
        <MenubarItem onClick={() => exec(OpenProjectCommand)}>
          Open Project... <MenubarShortcut>{modKey}+O</MenubarShortcut>
        </MenubarItem>
        <MenubarSub>
          <MenubarSubTrigger disabled={!projectLoaded}>Replace Videos...</MenubarSubTrigger>
          <MenubarSubContent>
            {labels?.videos.map((v, idx) => (
              <MenubarItem
                key={idx}
                onClick={async () => {
                  const { resolveVideoFile } = await import("../../lib/resolveVideos");
                  await resolveVideoFile(v);
                  useAppStore.getState().bumpOverlayVersion();
                }}
              >
                {(Array.isArray(v.filename) ? v.filename[0] : v.filename)?.split("/").pop() || `Video ${idx + 1}`}
              </MenubarItem>
            ))}
          </MenubarSubContent>
        </MenubarSub>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(SaveProjectCommand)}
        >
          Save <MenubarShortcut>{modKey}+S</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(SaveAsProjectCommand)}
        >
          Save As... <MenubarShortcut>{modKey}+Shift+S</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(ExportJsonCommand)}
        >
          Export JSON...
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(ExportCSVCommand)}
        >
          Export Analysis CSV...
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(ExportPackageCommand)}
        >
          Export Labels Package...
        </MenubarItem>
        {isTauri && (
          <>
            <MenubarSeparator />
            <MenubarItem
              disabled={!projectPath}
              onClick={async () => {
                if (!projectPath) return;
                const { invoke } = await import("@tauri-apps/api/core");
                try {
                  await invoke("reveal_in_file_manager", { path: projectPath });
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
                  await invoke("open_preferences_directory");
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
          </>
        )}
        <MenubarSeparator />
        <MenubarItem
          onClick={async () => {
            const { quitApp } = await import("../../lib/quit");
            await quitApp();
          }}
        >
          Quit <MenubarShortcut>{modKey}+Q</MenubarShortcut>
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

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  const canUndo = commandContext.canUndo;
  const canRedo = commandContext.canRedo;
  const undoLabel = canUndo
    ? `Undo ${commandContext.undoCommandName}`
    : "Undo";
  const redoLabel = canRedo
    ? `Redo ${commandContext.redoCommandName}`
    : "Redo";

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Edit</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!canUndo}
          onClick={() => commandContext.undo()}
        >
          {undoLabel} <MenubarShortcut>{modKey}+Z</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!canRedo}
          onClick={() => commandContext.redo()}
        >
          {redoLabel} <MenubarShortcut>{modKey}+Shift+Z</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            exec(CopyInstance);
            toast.info("Instance copied");
          }}
        >
          Copy Instance <MenubarShortcut>{modKey}+C</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!clipboardInstance}
          onClick={() => {
            exec(PasteInstance);
            toast.info("Instance pasted");
          }}
        >
          Paste Instance <MenubarShortcut>{modKey}+V</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(AddInstance)}
        >
          Add Instance <MenubarShortcut>{modKey}+I</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            exec(DeleteSelectedInstance);
            toast.info("Instance deleted");
          }}
        >
          Delete Instance <MenubarShortcut>{modKey}+Backspace</MenubarShortcut>
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
          Go to Frame... <MenubarShortcut>{modKey}+J</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => useAppStore.getState().setSelectToFrameDialogOpen(true)}
        >
          Select to Frame... <MenubarShortcut>{modKey}+Shift+J</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextLabeledFrame)}>
          Next Labeled Frame <MenubarShortcut>Alt+{"\u2192"}</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoPrevLabeledFrame)}>
          Previous Labeled Frame <MenubarShortcut>Alt+{"\u2190"}</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextSuggestion)}>
          Next Suggestion <MenubarShortcut>Space</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoPrevSuggestion)}>
          Previous Suggestion <MenubarShortcut>Shift+Space</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoToLastInteracted)}>
          Last Interacted Frame <MenubarShortcut>{modKey}+A</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextUserFrame)}>
          Next User Labeled Frame <MenubarShortcut>{modKey}+U</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled={!projectLoaded} onClick={() => exec(GoNextTrackSpawnFrame)}>
          Next Track Spawn Frame <MenubarShortcut>{modKey}+E</MenubarShortcut>
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
          Next Video <MenubarShortcut>Alt+Shift+{"\u2192"}</MenubarShortcut>
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
          Previous Video <MenubarShortcut>Alt+Shift+{"\u2190"}</MenubarShortcut>
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
  const colorPredicted = useAppStore((s) => s.colorPredicted);
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
  const uiScale = useAppStore((s) => s.uiScale);
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
              Increase <MenubarShortcut>{modKey}+Shift+=</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => adjustScale(-0.05)}>
              Decrease <MenubarShortcut>{modKey}+-</MenubarShortcut>
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
          checked={colorPredicted}
          onCheckedChange={() => toggle("colorPredicted")}
        >
          Color Predicted Instances
        </MenubarCheckboxItem>
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
          Show Non-Visible Nodes
        </MenubarCheckboxItem>
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
              onValueChange={(val) => setVal("distinctlyColor", val as "track" | "instance" | "node" | "edge")}
            >
              <MenubarRadioItem value="track">Tracks</MenubarRadioItem>
              <MenubarRadioItem value="instance">Instances</MenubarRadioItem>
              <MenubarRadioItem value="node">Nodes</MenubarRadioItem>
              <MenubarRadioItem value="edge">Edges</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarSubContent>
        </MenubarSub>
      </MenubarContent>
    </MenubarMenu>
  );
}

function LabelsMenu() {
  const labels = useAppStore((s) => s.labels);
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const instance = useAppStore((s) => s.instance);
  const instanceInitMethod = useAppStore((s) => s.instanceInitMethod);
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
          disabled={!projectLoaded}
          onClick={() => exec(AddInstance)}
        >
          Add Instance <MenubarShortcut>{modKey}+I</MenubarShortcut>
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
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(DeleteSelectedInstance)}
        >
          Delete Instance <MenubarShortcut>{modKey}+Backspace</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
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
          Delete Predictions from Area... <MenubarShortcut>{modKey}+K</MenubarShortcut>
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
  const set = useAppStore((s) => s.set);

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Predict</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          onClick={() => {
            set("sidebarActivePanel", "training");
            set("sidebarCollapsed", false);
          }}
        >
          Training...
        </MenubarItem>
        <MenubarItem
          onClick={() => {
            set("sidebarActivePanel", "inference");
            set("sidebarCollapsed", false);
          }}
        >
          Inference / Run Prediction...
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          onClick={() =>
            alert(
              "Export Training Package is not yet implemented.\n\nThis will bundle labels and video frames for training with sleap-nn."
            )
          }
        >
          Export Training Package...
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

  const exec = (cmd: Parameters<typeof commandContext.execute>[0]) => {
    commandContext.execute(cmd);
  };

  return (
    <MenubarMenu>
      <MenubarTrigger className="px-3 h-8 text-xs rounded-none">Tracks</MenubarTrigger>
      <MenubarContent>
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(TransposeInstances)}
        >
          Transpose Instance Tracks <MenubarShortcut>{modKey}+T</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(AddTrack)}
        >
          New Track <MenubarShortcut>{modKey}+0</MenubarShortcut>
        </MenubarItem>
        {labels?.tracks && labels.tracks.length > 0 && (
          <MenubarSub>
            <MenubarSubTrigger disabled={!instance}>Set Instance Track</MenubarSubTrigger>
            <MenubarSubContent>
              {labels.tracks.map((track, idx) => (
                <MenubarItem key={idx} onClick={() => commandContext.execute(SetInstanceTrack, { trackIdx: idx })}>
                  {track.name} {idx < 9 && <MenubarShortcut>{modKey}+{idx + 1}</MenubarShortcut>}
                </MenubarItem>
              ))}
            </MenubarSubContent>
          </MenubarSub>
        )}
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => exec(CopyTrack)}
        >
          Copy Instance Track <MenubarShortcut>{modKey}+Shift+C</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          disabled={!projectLoaded}
          onClick={() => exec(PasteTrack)}
        >
          Paste Instance Track <MenubarShortcut>{modKey}+Shift+V</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance || !instance.track}
          onClick={() => {
            const { instance: inst, labels: lbl } = useAppStore.getState();
            if (!inst?.track || !lbl) return;
            // Use the current track as both old and new (user should have
            // just swapped tracks on this frame via TransposeInstances first)
            // For now, propagate from the current track forward
            const tracks = lbl.tracks;
            if (tracks.length < 2) return;
            const trackIdx = tracks.indexOf(inst.track);
            const otherTrack = tracks[(trackIdx + 1) % tracks.length];
            exec(PropagateTrackLabels);
            // Since PropagateTrackLabels needs params, execute with them
            commandContext.execute(PropagateTrackLabels, {
              oldTrack: inst.track,
              newTrack: otherTrack,
            });
          }}
        >
          Propagate Track Labels
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          disabled={!instance}
          onClick={() => {
            if (confirm("Delete this instance and its track?"))
              exec(DeleteInstanceAndTrack);
          }}
        >
          Delete Instance and Track <MenubarShortcut>{modKey}+Shift+Backspace</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        {labels?.tracks && labels.tracks.length > 0 && (
          <MenubarSub>
            <MenubarSubTrigger disabled={!projectLoaded}>Delete Track</MenubarSubTrigger>
            <MenubarSubContent>
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
            useAppStore.getState().setShortcutsDialogOpen(true)
          }
        >
          Keyboard Shortcuts...
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
