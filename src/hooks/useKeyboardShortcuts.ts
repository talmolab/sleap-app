/**
 * Global keyboard shortcut handler using tinykeys.
 *
 * Binds shortcuts defined in lib/shortcuts.ts to command actions.
 * Navigation shortcuts that need immediate responsiveness call store directly.
 * Logical commands go through the CommandContext.
 */

import { useEffect } from "react";
import { tinykeys } from "tinykeys";
import { DEFAULT_SHORTCUTS, STEP_SIZES } from "../lib/shortcuts";
import { useAppStore } from "../stores/appStore";
import { Track } from "@talmolab/sleap-io.js";
import { quitApp } from "../lib/quit";
import { openNewInstance } from "../lib/newInstance";
import { dismiss } from "../lib/notify";
import {
  commandContext,
  OpenProjectCommand,
  SaveProjectCommand,
  SaveAsProjectCommand,
  GoNextLabeledFrame,
  GoPrevLabeledFrame,
  GoNextSuggestion,
  GoPrevSuggestion,
  GoToLastInteracted,
  GoNextUserFrame,
  GoNextTrackSpawnFrame,
  GoToStartFrame,
  GoToEndFrame,
  AddInstance,
  AddInstancesFromAllPredictions,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  TransposeInstances,
  AddTrack,
  SetInstanceTrack,
  CopyTrack,
  PasteTrack,
  DeleteInstanceAndTrack,
} from "../commands";

function isTextInput(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable === true;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const store = useAppStore.getState;

    const unsubscribe = tinykeys(window, {
      // Frame navigation (direct store for responsiveness)
      [DEFAULT_SHORTCUTS["frame next"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(STEP_SIZES.small);
      },
      [DEFAULT_SHORTCUTS["frame prev"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(-STEP_SIZES.small);
      },
      [DEFAULT_SHORTCUTS["frame next medium step"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(STEP_SIZES.medium);
      },
      [DEFAULT_SHORTCUTS["frame prev medium step"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(-STEP_SIZES.medium);
      },
      [DEFAULT_SHORTCUTS["frame next large step"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(STEP_SIZES.large);
      },
      [DEFAULT_SHORTCUTS["frame prev large step"]]: (e) => {
        e.preventDefault();
        store().incrementFrameIdx(-STEP_SIZES.large);
      },

      // Skip to start/end
      [DEFAULT_SHORTCUTS["goto start"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoToStartFrame);
      },
      [DEFAULT_SHORTCUTS["goto end"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoToEndFrame);
      },

      // Labeled frame navigation (via command system)
      [DEFAULT_SHORTCUTS["goto next labeled"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoNextLabeledFrame);
      },
      [DEFAULT_SHORTCUTS["goto prev labeled"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoPrevLabeledFrame);
      },

      // Suggestion navigation
      [DEFAULT_SHORTCUTS["goto next suggestion"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        commandContext.execute(GoNextSuggestion);
      },
      [DEFAULT_SHORTCUTS["goto prev suggestion"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        commandContext.execute(GoPrevSuggestion);
      },

      // Go to last interacted frame
      [DEFAULT_SHORTCUTS["goto last interacted"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoToLastInteracted);
      },
      [DEFAULT_SHORTCUTS["goto next user"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoNextUserFrame);
      },

      // View toggles (direct store)
      [DEFAULT_SHORTCUTS["show instances"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showInstances");
      },
      [DEFAULT_SHORTCUTS["show labels"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showLabels");
      },
      [DEFAULT_SHORTCUTS["show edges"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showEdges");
      },
      [DEFAULT_SHORTCUTS["toggle node visibility"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showNonVisibleNodes");
      },
      [DEFAULT_SHORTCUTS.fit]: (e) => {
        e.preventDefault();
        store().toggle("fit");
      },
      // Reset the video canvas view to default (zoom=1, no pan). Plain letter
      // key, so ignore it while typing in an input.
      [DEFAULT_SHORTCUTS["reset view"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().resetView();
      },
      [DEFAULT_SHORTCUTS["toggle pan mode"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("defaultToPan");
      },

      // Toggle place mode (N key)
      [DEFAULT_SHORTCUTS["toggle place mode"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const { labelingMode, instance, enterPlacementMode, exitPlacementMode } = store();
        if (labelingMode === "place") {
          exitPlacementMode();
        } else if (instance) {
          enterPlacementMode();
        }
      },

      // Node cycling in place mode (Tab / Shift+Tab)
      "Tab": (e) => {
        if (isTextInput(e)) return;
        const s = store();
        if (s.labelingMode !== "place" || !s.instance) return;
        e.preventDefault();
        const count = s.instance.points.length;
        if (count === 0) return;
        const current = s.placementNodeIdx ?? 0;
        s.set("placementNodeIdx", (current + 1) % count);
      },
      "Shift+Tab": (e) => {
        if (isTextInput(e)) return;
        const s = store();
        if (s.labelingMode !== "place" || !s.instance) return;
        e.preventDefault();
        const count = s.instance.points.length;
        if (count === 0) return;
        const current = s.placementNodeIdx ?? 0;
        s.set("placementNodeIdx", (current - 1 + count) % count);
      },

      // Instance editing (via command system)
      [DEFAULT_SHORTCUTS["add instance"]]: (e) => {
        e.preventDefault();
        commandContext.execute(AddInstance);
      },
      [DEFAULT_SHORTCUTS["delete instance"]]: (e) => {
        e.preventDefault();
        commandContext.execute(DeleteSelectedInstance);
      },
      [DEFAULT_SHORTCUTS["accept all predictions"]]: (e) => {
        e.preventDefault();
        commandContext.execute(AddInstancesFromAllPredictions);
      },

      // Track commands
      [DEFAULT_SHORTCUTS.transpose]: (e) => {
        e.preventDefault();
        commandContext.execute(TransposeInstances);
      },
      [DEFAULT_SHORTCUTS["add track"]]: (e) => {
        e.preventDefault();
        commandContext.execute(AddTrack);
      },
      [DEFAULT_SHORTCUTS["delete track"]]: (e) => {
        e.preventDefault();
        if (confirm("Delete this instance and its track?")) {
          commandContext.execute(DeleteInstanceAndTrack);
        }
      },
      [DEFAULT_SHORTCUTS["select to frame"]]: (e) => {
        e.preventDefault();
        store().setSelectToFrameDialogOpen(true);
      },

      // Set instance track via Ctrl+1-9 (core proofreading interaction)
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
          `$mod+Digit${n}`,
          (e: KeyboardEvent) => {
            e.preventDefault();
            const { labels, instance } = store();
            if (!labels || !instance) return;

            const trackIdx = n - 1; // 1-indexed for user, 0-indexed internally
            if (trackIdx >= labels.tracks.length) {
              // Create tracks up to the requested index
              while (labels.tracks.length <= trackIdx) {
                const trackNumber = labels.tracks.length + 1;
                labels.tracks.push(new Track(`Track ${trackNumber}`));
              }
            }
            commandContext.execute(SetInstanceTrack, { trackIdx });
          },
        ])
      ),

      // Next track spawn frame
      [DEFAULT_SHORTCUTS["goto next track spawn"]]: (e) => {
        e.preventDefault();
        commandContext.execute(GoNextTrackSpawnFrame);
      },

      // Dismiss ALL currently-stacked on-screen toasts at once. The no-id form
      // of sonner's dismiss clears the whole live stack. (This is distinct from
      // the NotificationsPanel "Clear" button, which empties history.)
      [DEFAULT_SHORTCUTS["dismiss all toasts"]]: (e) => {
        e.preventDefault();
        dismiss();
      },

      // Undo/Redo
      "$mod+KeyZ": (e) => {
        e.preventDefault();
        commandContext.undo();
      },
      "$mod+Shift+KeyZ": (e) => {
        e.preventDefault();
        commandContext.redo();
      },

      // File commands
      [DEFAULT_SHORTCUTS.open]: (e) => {
        e.preventDefault();
        commandContext.execute(OpenProjectCommand);
      },
      [DEFAULT_SHORTCUTS.new]: (e) => {
        e.preventDefault();
        // Open a fresh instance (new tab / native window) at the Welcome screen;
        // the current project stays put. The create-empty flow lives on the
        // Welcome screen's New Project button (NewProjectDialog).
        void openNewInstance();
      },
      [DEFAULT_SHORTCUTS.save]: (e) => {
        e.preventDefault();
        commandContext.execute(SaveProjectCommand);
      },
      [DEFAULT_SHORTCUTS["save as"]]: (e) => {
        e.preventDefault();
        commandContext.execute(SaveAsProjectCommand);
      },
      [DEFAULT_SHORTCUTS.close]: async (e) => {
        e.preventDefault();
        await quitApp();
      },

      // Copy/paste
      [DEFAULT_SHORTCUTS["copy instance"]]: (e) => {
        e.preventDefault();
        commandContext.execute(CopyInstance);
      },
      [DEFAULT_SHORTCUTS["paste instance"]]: (e) => {
        e.preventDefault();
        commandContext.execute(PasteInstance);
      },

      // Track copy/paste
      [DEFAULT_SHORTCUTS["copy track"]]: (e) => {
        e.preventDefault();
        commandContext.execute(CopyTrack);
      },
      [DEFAULT_SHORTCUTS["paste track"]]: (e) => {
        e.preventDefault();
        commandContext.execute(PasteTrack);
      },

      // Delete predictions from area (Ctrl+K)
      [DEFAULT_SHORTCUTS["delete area predictions"]]: (e) => {
        e.preventDefault();
        store().toggle("areaDeleteMode");
      },

      // Selection / exit placement mode / cancel area-delete
      [DEFAULT_SHORTCUTS["clear selection"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const s = store();
        if (s.areaDeleteMode) {
          s.set("areaDeleteMode", false);
        } else if (s.labelingMode === "place") {
          s.exitPlacementMode();
        } else {
          s.setInstance(null);
        }
      },
      [DEFAULT_SHORTCUTS["select next"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const { labeledFrame, instance } = store();
        if (!labeledFrame) return;
        const instances = labeledFrame.instances;
        if (instances.length === 0) return;
        if (!instance) {
          store().setInstance(instances[0]);
        } else {
          const idx = instances.indexOf(instance);
          store().setInstance(instances[(idx + 1) % instances.length]);
        }
      },

      // Cycle through instances on the current frame and zoom to fit each one
      // (Shift+Down / Shift+Up), mirroring the legacy sleap desktop app.
      [DEFAULT_SHORTCUTS["select next instance zoom"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const { labeledFrame, instance } = store();
        if (!labeledFrame) return;
        const instances = labeledFrame.instances;
        if (instances.length === 0) return;
        if (!instance) {
          store().setInstance(instances[0]);
        } else {
          const idx = instances.indexOf(instance);
          store().setInstance(instances[(idx + 1) % instances.length]);
        }
        store().set("fitSelection", true);
      },
      [DEFAULT_SHORTCUTS["select prev instance zoom"]]: (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const { labeledFrame, instance } = store();
        if (!labeledFrame) return;
        const instances = labeledFrame.instances;
        if (instances.length === 0) return;
        if (!instance) {
          store().setInstance(instances[instances.length - 1]);
        } else {
          const idx = instances.indexOf(instance);
          store().setInstance(instances[(idx - 1 + instances.length) % instances.length]);
        }
        store().set("fitSelection", true);
      },

      // Go to frame (Ctrl+J)
      [DEFAULT_SHORTCUTS["goto frame"]]: (e) => {
        e.preventDefault();
        store().setGoToFrameDialogOpen(true);
      },

      // UI scale
      "$mod+Shift+Equal": (e) => {
        e.preventDefault();
        const uiScale = store().uiScale;
        const newScale = Math.min(1.5, uiScale + 0.05);
        store().set("uiScale", Math.round(newScale * 100) / 100);
        document.documentElement.style.setProperty("--ui-scale", String(newScale));
      },
      "$mod+Minus": (e) => {
        e.preventDefault();
        const uiScale = store().uiScale;
        const newScale = Math.max(0.75, uiScale - 0.05);
        store().set("uiScale", Math.round(newScale * 100) / 100);
        document.documentElement.style.setProperty("--ui-scale", String(newScale));
      },

      // Video navigation
      [DEFAULT_SHORTCUTS["next video"]]: (e) => {
        e.preventDefault();
        const { labels, video } = store();
        if (!labels || !video) return;
        const idx = labels.videos.indexOf(video);
        const next = labels.videos[(idx + 1) % labels.videos.length];
        if (next) store().setVideo(next);
      },
      [DEFAULT_SHORTCUTS["prev video"]]: (e) => {
        e.preventDefault();
        const { labels, video } = store();
        if (!labels || !video) return;
        const idx = labels.videos.indexOf(video);
        const prev = labels.videos[(idx - 1 + labels.videos.length) % labels.videos.length];
        if (prev) store().setVideo(prev);
      },
    });

    return unsubscribe;
  }, []);
}
