/**
 * Global keyboard shortcut handler using tinykeys.
 *
 * Binds shortcuts defined in lib/shortcuts.ts to command actions.
 * Navigation shortcuts that need immediate responsiveness call store directly.
 * Logical commands go through the CommandContext.
 */

import { useEffect } from "react";
import { tinykeys } from "tinykeys";
import { STEP_SIZES, bindActions, type ShortcutOverrides } from "../lib/shortcuts";
import { EDITABLE_ACTIONS, isEditableAction, sanitizeOverrides } from "../lib/shortcutEditing";
import { currentAppMenu } from "../lib/menu/useAppMenu";
import { menuItemForAction } from "../lib/menu/menuShortcuts";
import { useAppStore, PREFERENCES_STORAGE_KEY } from "../stores/appStore";
import { Track } from "@talmolab/sleap-io.js";
import { confirmDeleteInstanceAndTrack } from "@/lib/trackDeleteConfirms";
import { quitApp } from "../lib/quit";
import { openNewInstance } from "../lib/newInstance";
import { dismiss, toast } from "../lib/notify";
import { hintIfPredictionsRemain } from "../lib/labelingHints";
import { spacePanState } from "../lib/spacePanTracking";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
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
  GoPrevUserFrame,
  GoToMarkedFrame,
  GoNextTrackSpawnFrame,
  GoNextQcFlag,
  GoPrevQcFlag,
  MarkQcFlagOk,
  GoToStartFrame,
  GoToEndFrame,
  AddInstance,
  AddInstancesFromAllPredictions,
  DeleteSelectedInstance,
  MergeInstance,
  CopyInstance,
  PasteInstance,
  requestTranspose,
  AddTrack,
  SetInstanceTrack,
  CopyTrack,
  PasteTrack,
  DeleteInstanceAndTrack,
} from "../commands";
import { requestToggleNegativeFrame } from "@/lib/negativeFrame";
import { isNativeMenuShortcut } from "@/lib/menu/nativeMenuOwnership";
import { handleQcReviewKey } from "@/stores/qcStore";
import { handleProposalKey } from "@/lib/proposalReview";

type Bindings = Record<string, (e: KeyboardEvent) => void>;

/** Each binding, skipped while the native menu owns its keystroke. */
function leaveNativeMenuShortcuts(bindings: Bindings): Bindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([binding, handler]) => [
      binding,
      (e: KeyboardEvent) => {
        if (isNativeMenuShortcut(binding)) return;
        handler(e);
      },
    ]),
  );
}

/** Inputs you don't type text into: keys there still go to the app. */
const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);

/**
 * Whether a key press is typing in a text field. A shortcut without ⌘/Ctrl
 * (a letter, an arrow, Space) leaves those alone, whatever the user bound.
 */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable === true || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
}

/** A binding with ⌘/Ctrl (or the Control key) is a command even while typing. */
function hasCommandModifier(binding: string): boolean {
  return binding.split("+").some((t) => t === "$mod" || t === "Control" || t === "Meta");
}

function isTextInput(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable === true;
}

/**
 * Editable actions with no handler of their own here (e.g. Delete Predictions
 * on Current Frame) run their menu item, if it's enabled, so any key the user
 * gives them works.
 */
function menuFallbacks(handled: Set<string>): Bindings {
  const out: Bindings = {};
  for (const action of EDITABLE_ACTIONS) {
    if (handled.has(action)) continue;
    out[action] = (e) => {
      if (isTextInput(e)) return;
      const item = menuItemForAction(currentAppMenu(), action);
      if (!item || item.enabled === false) return;
      e.preventDefault();
      void item.run();
    };
  }
  return out;
}

/**
 * The tinykeys map: each action's handler on the key(s) the user gave it
 * (or its defaults), plus the fixed keys. Where a fixed key that only acts
 * in one place (Tab in node placement mode, A/X/0 in Label QC Review) is
 * also an action's key, the fixed handler goes first and the action runs
 * only if it didn't take the key.
 */
export function buildKeyBindings(handlers: Bindings, overrides: ShortcutOverrides): Bindings {
  const actions: Bindings = {};
  const fixed: Bindings = {};
  for (const [name, handler] of Object.entries(handlers)) {
    if (isEditableAction(name)) actions[name] = handler;
    else fixed[name] = handler;
  }
  const out = bindActions({ ...menuFallbacks(new Set(Object.keys(actions))), ...actions }, overrides);
  // The user can bind plain keys to actions that only ever had ⌘ keys (Fit,
  // Close, …): never run those while typing in a text field.
  for (const [key, handler] of Object.entries(out)) {
    if (!hasCommandModifier(key)) {
      out[key] = (e) => {
        if (isTypingTarget(e)) return;
        handler(e);
      };
    }
  }
  for (const [key, handler] of Object.entries(fixed)) {
    const action = out[key];
    out[key] = action
      ? (e) => {
          handler(e);
          if (!e.defaultPrevented) action(e);
        }
      : handler;
  }
  return out;
}

export function useKeyboardShortcuts() {
  const overrides = useAppStore((s) => s.shortcutOverrides);
  useEffect(() => {
    const store = useAppStore.getState;

    // Handlers by action name (see lib/shortcuts.ts), bound to the user's
    // keys; the rest are fixed keys. On macOS desktop the native menu owns
    // its ⌘ shortcuts: leave those to it (not preventDefault-ed, so the menu
    // still gets the keystroke).
    const unsubscribe = tinykeys(window, leaveNativeMenuShortcuts(buildKeyBindings({
      // Frame navigation (direct store for responsiveness). In the Label QC
      // Review window ← / → step through the flags instead.
      "frame next": (e) => {
        e.preventDefault();
        if (handleQcReviewKey("frame next")) return;
        store().incrementFrameIdx(STEP_SIZES.small);
      },
      "frame prev": (e) => {
        e.preventDefault();
        if (handleQcReviewKey("frame prev")) return;
        store().incrementFrameIdx(-STEP_SIZES.small);
      },
      "frame next medium step": (e) => {
        if (isTextInput(e)) return; // ⌘←/→ moves the caret in a text field
        e.preventDefault();
        store().incrementFrameIdx(store().mediumStepSize);
      },
      "frame prev medium step": (e) => {
        if (isTextInput(e)) return; // ⌘←/→ moves the caret in a text field
        e.preventDefault();
        store().incrementFrameIdx(-store().mediumStepSize);
      },
      "frame next large step": (e) => {
        if (isTextInput(e)) return; // ⌘←/→ moves the caret in a text field
        e.preventDefault();
        store().incrementFrameIdx(store().largeStepSize);
      },
      "frame prev large step": (e) => {
        if (isTextInput(e)) return; // ⌘←/→ moves the caret in a text field
        e.preventDefault();
        store().incrementFrameIdx(-store().largeStepSize);
      },

      // Skip to start/end
      "goto start": (e) => {
        e.preventDefault();
        commandContext.execute(GoToStartFrame);
      },
      "goto end": (e) => {
        e.preventDefault();
        commandContext.execute(GoToEndFrame);
      },

      // Labeled frame navigation (via command system)
      "goto next labeled": (e) => {
        e.preventDefault();
        commandContext.execute(GoNextLabeledFrame);
      },
      "goto prev labeled": (e) => {
        e.preventDefault();
        commandContext.execute(GoPrevLabeledFrame);
      },

      // Suggestion navigation (Space / Shift+Space). Only preventDefault here
      // -- the actual jump is deferred to key-release below, so a hold-Space-
      // then-drag pan gesture (VideoPlayer.tsx) doesn't also jump frames out
      // from under the drag the instant Space goes down.
      "goto next suggestion": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        // A key other than Space acts at once (a ⌘ combo never gets its
        // keyup on macOS while ⌘ is held).
        if (e.code !== "Space") commandContext.execute(GoNextSuggestion);
      },
      "goto prev suggestion": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        if (e.code !== "Space") commandContext.execute(GoPrevSuggestion);
      },

      // Go to last interacted frame
      "goto last interacted": (e) => {
        e.preventDefault();
        commandContext.execute(GoToLastInteracted);
      },
      "goto next user": (e) => {
        e.preventDefault();
        commandContext.execute(GoNextUserFrame);
      },
      "goto prev user": (e) => {
        e.preventDefault();
        commandContext.execute(GoPrevUserFrame);
      },

      // Mark the current frame / jump back to it (PyQt Ctrl+M / Ctrl+Shift+M).
      "mark frame": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const s = store();
        if (!s.video) return;
        s.setMarkedFrame({ video: s.video, frameIdx: s.frameIdx });
        toast.info(`Marked frame ${s.frameIdx.toLocaleString()}`, {
          id: "mark-frame",
          duration: 1400,
        });
      },
      "goto marked frame": (e) => {
        e.preventDefault();
        commandContext.execute(GoToMarkedFrame);
      },

      // Open the Training panel (PyQt "learning" dialog, Ctrl+L).
      "learning": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().openPanel("training");
      },

      // View toggles (direct store)
      "show instances": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showInstances");
      },
      "show labels": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showLabels");
      },
      "show edges": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showEdges");
      },
      "show non-visible nodes": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("showNonVisibleNodes");
      },
      "fit": (e) => {
        e.preventDefault();
        store().setZoomMode("fit", !store().fit);
      },
      // Reset the video canvas view to default (zoom=1, no pan). Plain letter
      // key, so ignore it while typing in an input.
      "reset view": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().resetView();
      },
      "toggle pan mode": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("defaultToPan");
      },
      "box tool": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("bboxDrawMode");
      },

      // Label QC review queue (F / Shift+F; 3 marks the selected flag OK).
      "goto next qc flag": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        commandContext.execute(GoNextQcFlag);
      },
      "goto prev qc flag": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        commandContext.execute(GoPrevQcFlag);
      },
      "ignore qc flag": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        commandContext.execute(MarkQcFlagOk);
      },
      // Label QC Review only: 0 zooms back to the flagged instance.
      Digit0: (e) => {
        if (isTextInput(e)) return;
        if (handleQcReviewKey("refit")) e.preventDefault();
      },
      // Label QC Review only: A / X accept / reject Claude's suggestion on screen.
      KeyA: (e) => {
        if (isTextInput(e)) return;
        if (handleProposalKey("accept")) e.preventDefault();
      },
      KeyX: (e) => {
        if (isTextInput(e)) return;
        if (handleProposalKey("reject")) e.preventDefault();
      },

      // Mark Frame as Negative (N, as in SLEAP) — asks first if it would remove instances.
      "mark negative": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        void requestToggleNegativeFrame();
      },

      // Merge Instance (Shift+M): merge another user instance into the selected one.
      "merge instance": (e) => {
        if (isTextInput(e)) return;
        if (!store().instance) return;
        e.preventDefault();
        commandContext.execute(MergeInstance);
      },

      // Toggle place mode (Shift+N)
      "toggle place mode": (e) => {
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
      "add instance": (e) => {
        e.preventDefault();
        commandContext.execute(AddInstance);
      },
      "delete instance": (e) => {
        e.preventDefault();
        commandContext.execute(DeleteSelectedInstance);
      },
      "accept all predictions": (e) => {
        e.preventDefault();
        commandContext.execute(AddInstancesFromAllPredictions);
      },

      // Track commands
      "transpose": (e) => {
        e.preventDefault();
        requestTranspose(commandContext);
      },
      // Tracks ▸ Propagate Track Labels on/off (Shift+P). The setting is
      // otherwise only visible in the menu, so say which way it went.
      "propagate track labels": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        store().toggle("propagateTrackLabels");
        const on = store().propagateTrackLabels;
        toast.info(`Propagate Track Labels ${on ? "on" : "off"}`, {
          id: "propagate-track-labels",
          duration: 1400,
        });
      },
      "add track": (e) => {
        e.preventDefault();
        commandContext.execute(AddTrack);
      },
      "delete track": async (e) => {
        e.preventDefault();
        if (await confirmDeleteInstanceAndTrack(commandContext.state)) {
          commandContext.execute(DeleteInstanceAndTrack);
        }
      },
      "select to frame": (e) => {
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
              // These new tracks are pushed directly (not via the AddTrack
              // command), so the autosave classifier never sees them — mark
              // structural so the next tick rewrites the base (the delta can't
              // encode a track absent from the base). Belt-and-suspenders with
              // the tick-time structural-signature backstop.
              dirtyFrameTracker.markStructural();
            }
            commandContext.execute(SetInstanceTrack, { trackIdx });
          },
        ])
      ),

      // Next track spawn frame
      "goto next track spawn": (e) => {
        e.preventDefault();
        commandContext.execute(GoNextTrackSpawnFrame);
      },

      // Dismiss ALL currently-stacked on-screen toasts at once. The no-id form
      // of sonner's dismiss clears the whole live stack. (This is distinct from
      // the NotificationsPanel "Clear" button, which empties history.)
      "dismiss all toasts": (e) => {
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
      "open": (e) => {
        e.preventDefault();
        commandContext.execute(OpenProjectCommand);
      },
      "new": (e) => {
        e.preventDefault();
        // Open a fresh instance (new tab / native window) at the Welcome screen;
        // the current project stays put. The create-empty flow lives on the
        // Welcome screen's New Project button (NewProjectDialog).
        void openNewInstance();
      },
      "save": (e) => {
        e.preventDefault();
        commandContext.execute(SaveProjectCommand);
      },
      "save as": (e) => {
        e.preventDefault();
        commandContext.execute(SaveAsProjectCommand);
      },
      "close": async (e) => {
        e.preventDefault();
        await quitApp();
      },

      // Copy/paste
      "copy instance": (e) => {
        e.preventDefault();
        commandContext.execute(CopyInstance);
      },
      "paste instance": (e) => {
        e.preventDefault();
        commandContext.execute(PasteInstance);
      },

      // Track copy/paste
      "copy track": (e) => {
        e.preventDefault();
        commandContext.execute(CopyTrack);
      },
      "paste track": (e) => {
        e.preventDefault();
        commandContext.execute(PasteTrack);
      },

      // Delete predictions from area (Ctrl+K)
      "delete area predictions": (e) => {
        e.preventDefault();
        store().toggle("areaDeleteMode");
      },

      // Selection / exit placement mode / cancel area-delete
      "clear selection": (e) => {
        if (isTextInput(e)) return;
        e.preventDefault();
        const s = store();
        if (s.areaDeleteMode) {
          s.set("areaDeleteMode", false);
        } else if (s.labelingMode === "place") {
          s.exitPlacementMode();
        } else if (handleQcReviewKey("clear selection")) {
          // Closed the Label QC Review window.
        } else {
          hintIfPredictionsRemain(s.instance, s.labeledFrame);
          s.setInstance(null);
        }
      },
      "select next": (e) => {
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
      "select next instance zoom": (e) => {
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
      "select prev instance zoom": (e) => {
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
      "goto frame": (e) => {
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
      "next video": (e) => {
        e.preventDefault();
        const { labels, video } = store();
        if (!labels || !video) return;
        const idx = labels.videos.indexOf(video);
        const next = labels.videos[(idx + 1) % labels.videos.length];
        if (next) store().setVideo(next);
      },
      "prev video": (e) => {
        e.preventDefault();
        const { labels, video } = store();
        if (!labels || !video) return;
        const idx = labels.videos.indexOf(video);
        const prev = labels.videos[(idx - 1 + labels.videos.length) % labels.videos.length];
        if (prev) store().setVideo(prev);
      },
    }, overrides)));

    // Suggestion navigation on Space/Shift+Space fires on *release*, not
    // press, and only if no pan-drag happened while Space was held (see
    // spacePanTracking.ts) -- see the stubs above. Only the Space keys are
    // bound here; any other key the user gives these actions acts on press.
    const unsubscribeSuggestionNav = tinykeys(
      window,
      onlySpaceKeys(bindActions<(e: KeyboardEvent) => void>({
        "goto next suggestion": (e) => {
          if (isTextInput(e)) return;
          if (spacePanState.draggedWhileHeld) return;
          commandContext.execute(GoNextSuggestion);
        },
        "goto prev suggestion": (e) => {
          if (isTextInput(e)) return;
          if (spacePanState.draggedWhileHeld) return;
          commandContext.execute(GoPrevSuggestion);
        },
      }, overrides)),
      { event: "keyup" }
    );

    return () => {
      unsubscribe();
      unsubscribeSuggestionNav();
    };
  }, [overrides]);

  // Another window saved new shortcuts: take them, so this window neither
  // keeps the old keys nor writes them back over the new ones.
  useEffect(() => syncShortcutsAcrossWindows(), []);
}

/** The bindings whose key is Space (with any modifiers). */
function onlySpaceKeys(bindings: Bindings): Bindings {
  return Object.fromEntries(Object.entries(bindings).filter(([key]) => key.split("+").includes("Space")));
}

/**
 * Follow shortcut changes saved by another window (desktop windows and
 * browser tabs share the preferences in localStorage). Returns unsubscribe.
 */
export function syncShortcutsAcrossWindows(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PREFERENCES_STORAGE_KEY || !e.newValue) return;
    let saved: unknown;
    try {
      saved = (JSON.parse(e.newValue) as { state?: { shortcutOverrides?: unknown } }).state?.shortcutOverrides;
    } catch {
      return;
    }
    const next = sanitizeOverrides(saved);
    if (JSON.stringify(next) !== JSON.stringify(useAppStore.getState().shortcutOverrides)) {
      useAppStore.getState().set("shortcutOverrides", next);
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
