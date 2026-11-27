/**
 * Prompts about SLP file formats, rendered by
 * {@link import("@/components/dialogs/SlpFormatDialog").SlpFormatDialog}:
 *
 * - `refused`: sleap-io.js cannot read the file. Says what the file is, which
 *   tool reads it, and how to save a copy this app can open.
 * - `open`: the file is in SLP format 3.0 and contains tables this version
 *   does not read. The user opens it View only (nothing is written back) or
 *   for editing (saving writes format 3.0 and drops the unread tables listed
 *   in the dialog).
 * - `merge`: the same, for a file merged into the open project.
 * - `allow-edit`: a view-only project is about to be made editable (from the
 *   banner, or when the user saves or exports it). Shows the same list.
 * - `upgrade-on-save`: an existing on-disk SLP 2.x file now contains SLP 3.0
 *   features (unlabeled nodes or metadata) and is about to be overwritten.
 *   Asks once whether to save as SLP 3.0, Save As a new file, or export a 2.x
 *   copy instead.
 *
 * Also holds the open state of the `SaveSlpCopyDialog` (`File ▸ Export ▸ SLP
 * Copy…` and the StatusBar format popover) so format-lifecycle UI does not
 * require coupling into `appStore`.
 *
 * Promise-based like {@link import("@/stores/choiceStore").choiceDialog}: one
 * prompt at a time; a new one supersedes a pending one (answered `null`).
 */
import { create } from "zustand";
import type { Format3Summary, SlpVersion } from "@talmolab/sleap-io.js";
import type { AllowEditAction } from "@/lib/slpAccess";

export type SlpFormatPrompt =
  | {
      kind: "refused";
      /** The file's name, as shown to the user. */
      fileName: string;
      formatId: number | null;
      unsupportedFeatures: string[];
      /** The file's format 3.0 tables are inconsistent (`SlpTableError`). */
      damagedTables?: boolean;
      /** sleap-io.js's own message, shown as detail. */
      detail: string;
    }
  | {
      kind: "open" | "merge";
      fileName: string;
      summary: Format3Summary;
    }
  | {
      kind: "allow-edit";
      fileName: string;
      summary: Format3Summary;
      /** What the user was doing when asked, if anything. */
      action?: AllowEditAction;
    }
  | {
      kind: "upgrade-on-save";
      fileName: string;
      summary: Format3Summary;
    };

/**
 * `view`/`keep` (or `edit`) for the open choice, `keep`/`edit` to merge or
 * allow editing, `ok` to dismiss a refusal, or `upgrade-v3`/`save-as`/
 * `export-v2` for the one-time 2.x -> 3.0 overwrite confirmation.
 */
export type SlpFormatAnswer =
  | "view"
  | "keep"
  | "edit"
  | "ok"
  | "upgrade-v3"
  | "save-as"
  | "export-v2"
  | null;

interface SlpFormatStore {
  prompt: SlpFormatPrompt | null;
  /**
   * Incremented when Desktop `[Upgrade]` is clicked on the Welcome screen
   * (where the sidebar is not mounted yet) so WelcomeScreen opens its
   * Environment section.
   */
  welcomeEnvironmentRequestSeq: number;
  /** Open state for the `File ▸ Export ▸ SLP Copy…` dialog. */
  saveSlpCopyDialogOpen: boolean;
  /** Initial target layout when `SaveSlpCopyDialog` opens. */
  saveSlpCopyInitialVersion: SlpVersion;
  ask: (prompt: SlpFormatPrompt) => Promise<SlpFormatAnswer>;
  respond: (answer: SlpFormatAnswer) => void;
  requestWelcomeEnvironment: () => void;
  openSaveSlpCopyDialog: (initialVersion?: SlpVersion) => void;
  setSaveSlpCopyDialogOpen: (open: boolean) => void;
}

let resolver: ((answer: SlpFormatAnswer) => void) | null = null;

export const useSlpFormatStore = create<SlpFormatStore>((set) => ({
  prompt: null,
  welcomeEnvironmentRequestSeq: 0,
  saveSlpCopyDialogOpen: false,
  saveSlpCopyInitialVersion: "auto",
  ask: (prompt) =>
    new Promise<SlpFormatAnswer>((resolve) => {
      resolver?.(null);
      resolver = resolve;
      set({ prompt });
    }),
  respond: (answer) => {
    const r = resolver;
    resolver = null;
    set({ prompt: null });
    r?.(answer);
  },
  requestWelcomeEnvironment: () =>
    set((s) => ({
      welcomeEnvironmentRequestSeq: s.welcomeEnvironmentRequestSeq + 1,
    })),
  openSaveSlpCopyDialog: (initialVersion = "auto") =>
    set({
      saveSlpCopyDialogOpen: true,
      saveSlpCopyInitialVersion: initialVersion,
    }),
  setSaveSlpCopyDialogOpen: (open) => set({ saveSlpCopyDialogOpen: open }),
}));

/** Show an SLP format prompt; resolves the answer, or null on Cancel / dismiss. */
export function askSlpFormat(prompt: SlpFormatPrompt): Promise<SlpFormatAnswer> {
  return useSlpFormatStore.getState().ask(prompt);
}

/**
 * Bumped whenever a loaded project's access changes in place (View only to
 * editable), so components that show the view-only state re-render.
 */
export const useSlpAccessNonce = create<{ nonce: number; bump: () => void }>((set) => ({
  nonce: 0,
  bump: () => set((s) => ({ nonce: s.nonce + 1 })),
}));
