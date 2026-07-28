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
import { rejectCurrentPassItem, skipCurrentPassItem } from "../lib/activeLearning/passActions";
import { openNewInstance } from "../lib/newInstance";
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

      // Suggestion navigation. In seed mode VideoPlayer's own Space handler
      // owns advancing (Space is otherwise pan/zoom there), so skip here to
      // avoid a double-advance. In keypointPass mode the pass cursor owns the
      // frame, so free Space-navigation would desync it — skip there too.
      [DEFAULT_SHORTCUTS["goto next suggestion"]]: (e) => {
        if (isTextInput(e)) return;
        const m = store().labelingMode;
        // Correct mode owns Space (accept + advance), handled in VideoPlayer.
        if (m === "seed" || m === "keypointPass" || m === "correct") return;
        e.preventDefault();
        commandContext.execute(GoNextSuggestion);
      },
      [DEFAULT_SHORTCUTS["goto prev suggestion"]]: (e) => {
        if (isTextInput(e)) return;
        const m = store().labelingMode;
        if (m === "seed" || m === "keypointPass" || m === "correct") return;
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
        // Don't switch into placement mid-sweep — it orphans the pass/queue.
        if (labelingMode === "keypointPass" || labelingMode === "correct") return;
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
        // Adding an instance mid-sweep changes the frame's instance count and
        // desyncs the work-list/queue indices — block it.
        const m = store().labelingMode;
        if (m === "keypointPass" || m === "correct") return;
        commandContext.execute(AddInstance);
      },
      [DEFAULT_SHORTCUTS["delete instance"]]: (e) => {
        e.preventDefault();
        // Deleting an instance mid-sweep would splice the frame's instances and
        // shift the work-list/queue indices the sweep resolves against — block it.
        const m = store().labelingMode;
        if (m === "keypointPass" || m === "correct") return;
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
      [DEFAULT_SHORTCUTS["delete track"]]: (e) => {
        e.preventDefault();
        // See "delete instance": splicing an instance mid-sweep desyncs it.
        const m = store().labelingMode;
        if (m === "keypointPass" || m === "correct") return;
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
        // Area-delete splices predictions out of the frame, desyncing a sweep.
        const m = store().labelingMode;
        if (m === "keypointPass" || m === "correct") return;
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
        } else if (s.labelingMode === "seed") {
          s.exitSeedMode();
        } else if (s.labelingMode === "keypointPass") {
          s.exitKeypointPassMode();
        } else if (s.labelingMode === "correct") {
          s.exitCorrectMode();
        } else {
          s.setInstance(null);
        }
      },

      // Phase-2 keypoint pass / Phase-3 correction step keys. s = skip (advance
      // without placing/accepting); b / Backspace = step back. Gated on the mode
      // so they're inert everywhere else.
      //
      // Shift+S = skip the whole INSTANCE (this animal isn't labelable), not just
      // the current node. Declared before the bare `KeyS` for readability only —
      // tinykeys matches modifiers exactly, so `KeyS` never fires with Shift held
      // and the two can't both run.
      "Shift+KeyS": (e) => {
        if (isTextInput(e)) return;
        if (store().labelingMode !== "keypointPass") return;
        // Repeat-guarded: holding the key would write off a run of animals.
        if (e.repeat) return;
        e.preventDefault();
        skipCurrentPassItem();
      },
      KeyS: (e) => {
        if (isTextInput(e)) return;
        const m = store().labelingMode;
        if (m === "keypointPass") {
          e.preventDefault();
          store().passAdvance();
        } else if (m === "correct") {
          // Skip: leave this prediction as-is (unaccepted) and move on. Guard
          // key-repeat so holding S can't skip the whole queue in one press.
          if (e.repeat) return;
          e.preventDefault();
          store().correctAdvance();
        }
      },
      KeyB: (e) => {
        if (isTextInput(e)) return;
        const m = store().labelingMode;
        if (m === "keypointPass") {
          e.preventDefault();
          store().passStepBack();
        } else if (m === "correct") {
          if (e.repeat) return;
          e.preventDefault();
          store().correctBack();
        }
      },
      // x = reject the locator detection under the cursor as a false positive
      // (deletes it, then continues at the next undecided point). Repeat-guarded
      // so holding the key can't wipe a run of detections.
      //
      // `includePredicted: true` is safe to hardcode here even though the sweep's
      // checkbox lives in the panel: a reject requires the current item to BE a
      // prediction, and when the user turned predictions off the work list holds
      // none — so this rebuild can only ever run for a list that included them.
      KeyX: (e) => {
        if (isTextInput(e)) return;
        if (store().labelingMode !== "keypointPass") return;
        if (e.repeat) return;
        e.preventDefault();
        rejectCurrentPassItem({ includePredicted: true });
      },
      Backspace: (e) => {
        if (isTextInput(e)) return;
        const m = store().labelingMode;
        if (m === "keypointPass") {
          e.preventDefault();
          store().passStepBack();
        } else if (m === "correct") {
          if (e.repeat) return;
          e.preventDefault();
          store().correctBack();
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
