/**
 * `useAppMenu()`: the app menu (`buildAppMenu`) for the current state,
 * rebuilt when anything it shows changes.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, type AppState } from "@/stores/appStore";
import { commandContext } from "@/commands";
import { humanizeCommandName } from "@/lib/humanizeCommand";
import { isTauri } from "@/lib/platform";
import { buildAppMenu, type MenuSnapshot } from "./appMenu";
import type { AppMenu } from "./types";

/**
 * The store fields the menus depend on — raw values and object references
 * only, so `useShallow` can tell when one changed (derived arrays built here
 * would be new on every call). `labeledFrame`, `hasChanges` and
 * `overlayVersion` carry no menu text themselves: they change when the undo
 * stack, the skeleton or the frame's instances do, which aren't store fields.
 */
function pickInputs(s: AppState) {
  return {
    projectLoaded: s.projectLoaded,
    projectPath: s.projectPath,
    labels: s.labels,
    labeledFrame: s.labeledFrame,
    hasChanges: s.hasChanges,
    overlayVersion: s.overlayVersion,
    instance: s.instance,
    clipboardInstance: s.clipboardInstance,
    skeleton: s.skeleton,
    navigationDomain: s.navigationDomain,
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarSide: s.sidebarSide,
    sidebarMultiPanel: s.sidebarMultiPanel,
    fit: s.fit,
    defaultToPan: s.defaultToPan,
    labelingMode: s.labelingMode,
    showInstances: s.showInstances,
    showNonVisibleNodes: s.showNonVisibleNodes,
    qcDisplayMode: s.qcDisplayMode,
    showLabels: s.showLabels,
    showEdges: s.showEdges,
    showCrosshair: s.showCrosshair,
    showInset: s.showInset,
    edgeStyle: s.edgeStyle,
    markerSize: s.markerSize,
    nodeLabelSize: s.nodeLabelSize,
    trailLength: s.trailLength,
    palette: s.palette,
    distinctlyColor: s.distinctlyColor,
    colorPredicted: s.colorPredicted,
    showTrackScore: s.showTrackScore,
    scrubProxyEnabled: s.scrubProxyEnabled,
    hiddenPanels: s.hiddenPanels,
    instanceInitMethod: s.instanceInitMethod,
    showLabelingHints: s.showLabelingHints,
    frameRange: s.frameRange,
    overlayModelPaths: s.overlayModelPaths,
    overlayModelOutputs: s.overlayModelOutputs,
    propagateTrackLabels: s.propagateTrackLabels,
    seekbarHeaderGraph: s.seekbarHeaderGraph,
  };
}

type MenuInputs = ReturnType<typeof pickInputs>;

function videoName(v: { filename: string | string[] }, idx: number): string {
  const first = Array.isArray(v.filename) ? v.filename[0] : v.filename;
  return first?.split("/").pop() || `Video ${idx + 1}`;
}

/** What the menus show, from the store's current inputs. */
export function snapshotFrom(i: MenuInputs): MenuSnapshot {
  const canUndo = commandContext.canUndo;
  const canRedo = commandContext.canRedo;
  return {
    isTauri,
    projectLoaded: i.projectLoaded,
    hasProjectPath: !!i.projectPath,
    videoNames: i.labels?.videos.map(videoName) ?? [],
    trackNames: i.labels?.tracks.map((t) => t.name) ?? [],
    hasInstance: !!i.instance,
    hasClipboardInstance: !!i.clipboardInstance,
    // Instances need a skeleton with at least one node (a node-less skeleton
    // would yield a null instance).
    skeletonHasNodes: (i.skeleton?.nodes?.length ?? 0) > 0,
    undoLabel: canUndo ? `Undo ${humanizeCommandName(commandContext.undoCommandName ?? "")}` : null,
    redoLabel: canRedo ? `Redo ${humanizeCommandName(commandContext.redoCommandName ?? "")}` : null,
    navigationDomain: i.navigationDomain,
    sidebarCollapsed: i.sidebarCollapsed,
    sidebarSide: i.sidebarSide,
    sidebarMultiPanel: i.sidebarMultiPanel,
    fit: i.fit,
    defaultToPan: i.defaultToPan,
    placementMode: i.labelingMode === "place",
    showInstances: i.showInstances,
    showNonVisibleNodes: i.showNonVisibleNodes,
    qcDisplayMode: i.qcDisplayMode,
    showLabels: i.showLabels,
    showEdges: i.showEdges,
    showCrosshair: i.showCrosshair,
    showInset: i.showInset,
    edgeStyle: i.edgeStyle,
    markerSize: i.markerSize,
    nodeLabelSize: i.nodeLabelSize,
    trailLength: i.trailLength,
    palette: i.palette,
    distinctlyColor: i.distinctlyColor,
    colorPredicted: i.colorPredicted,
    showTrackScore: i.showTrackScore,
    scrubProxyEnabled: i.scrubProxyEnabled,
    hiddenPanels: i.hiddenPanels,
    instanceInitMethod: i.instanceInitMethod,
    showLabelingHints: i.showLabelingHints,
    frameIsNegative: i.labeledFrame?.isNegative ?? false,
    hasFrameRange: i.frameRange !== null,
    totalLabeled: i.labels?.labeledFrames.length ?? 0,
    totalInstances:
      i.labels?.labeledFrames.reduce((sum, lf) => sum + lf.instances.length, 0) ?? 0,
    overlayModelCount: i.overlayModelPaths.length,
    overlayModelOutputs: i.overlayModelOutputs,
    propagateTrackLabels: i.propagateTrackLabels,
    seekbarHeaderGraph: i.seekbarHeaderGraph,
  };
}

/** The menus for the current state (for one-off reads outside React). */
export function currentAppMenu(): AppMenu {
  return buildAppMenu(snapshotFrom(pickInputs(useAppStore.getState())));
}

export function useAppMenu(): AppMenu {
  const inputs = useAppStore(useShallow(pickInputs));
  return useMemo(() => buildAppMenu(snapshotFrom(inputs)), [inputs]);
}

/** Subscribe to the menus outside React (the native menu); returns unsubscribe. */
export function subscribeAppMenu(onChange: (menu: AppMenu) => void): () => void {
  let last = pickInputs(useAppStore.getState());
  onChange(buildAppMenu(snapshotFrom(last)));
  return useAppStore.subscribe((state) => {
    const next = pickInputs(state);
    const keys = Object.keys(next) as (keyof MenuInputs)[];
    if (keys.every((k) => Object.is(next[k], last[k]))) return;
    last = next;
    onChange(buildAppMenu(snapshotFrom(next)));
  });
}
