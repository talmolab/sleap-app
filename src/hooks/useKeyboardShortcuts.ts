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
import {
  commandContext,
  OpenProjectCommand,
  NewProjectCommand,
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
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  TransposeInstances,
  AddTrack,
  SetInstanceTrack,
  CopyTrack,
  PasteTrack,
} from "../commands";

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
        e.preventDefault();
        commandContext.execute(GoNextSuggestion);
      },
      [DEFAULT_SHORTCUTS["goto prev suggestion"]]: (e) => {
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
        e.preventDefault();
        store().toggle("showInstances");
      },
      [DEFAULT_SHORTCUTS["show labels"]]: (e) => {
        e.preventDefault();
        store().toggle("showLabels");
      },
      [DEFAULT_SHORTCUTS["show edges"]]: (e) => {
        e.preventDefault();
        store().toggle("showEdges");
      },
      [DEFAULT_SHORTCUTS.fit]: (e) => {
        e.preventDefault();
        store().toggle("fit");
      },
      [DEFAULT_SHORTCUTS["toggle pan mode"]]: (e) => {
        e.preventDefault();
        store().toggle("defaultToPan");
      },

      // Toggle place mode (N key)
      [DEFAULT_SHORTCUTS["toggle place mode"]]: (e) => {
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
        const { labelingMode, instance, placementNodeIdx } = store();
        if (labelingMode !== "place" || !instance) return;
        e.preventDefault();
        const count = instance.points.length;
        if (count === 0) return;
        const current = placementNodeIdx ?? 0;
        store().set("placementNodeIdx", (current + 1) % count);
      },
      "Shift+Tab": (e) => {
        const { labelingMode, instance, placementNodeIdx } = store();
        if (labelingMode !== "place" || !instance) return;
        e.preventDefault();
        const count = instance.points.length;
        if (count === 0) return;
        const current = placementNodeIdx ?? 0;
        store().set("placementNodeIdx", (current - 1 + count) % count);
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

      // Track commands
      [DEFAULT_SHORTCUTS.transpose]: (e) => {
        e.preventDefault();
        commandContext.execute(TransposeInstances);
      },
      [DEFAULT_SHORTCUTS["add track"]]: (e) => {
        e.preventDefault();
        commandContext.execute(AddTrack);
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
        commandContext.execute(NewProjectCommand);
      },
      [DEFAULT_SHORTCUTS.save]: (e) => {
        e.preventDefault();
        commandContext.execute(SaveProjectCommand);
      },
      [DEFAULT_SHORTCUTS["save as"]]: (e) => {
        e.preventDefault();
        commandContext.execute(SaveAsProjectCommand);
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

      // Selection / exit placement mode
      [DEFAULT_SHORTCUTS["clear selection"]]: (e) => {
        e.preventDefault();
        const { labelingMode, exitPlacementMode } = store();
        if (labelingMode === "place") {
          exitPlacementMode();
        } else {
          store().setInstance(null);
        }
      },
      [DEFAULT_SHORTCUTS["select next"]]: (e) => {
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
