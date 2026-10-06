/**
 * App-wide promise-based multi-choice prompt — a 3+-option sibling of
 * {@link import("@/stores/confirmStore").confirmDialog} (which is binary). Rendered
 * as an in-WebView React modal ({@link import("@/components/dialogs/ChoiceDialog").ChoiceDialog})
 * styled to match SLEAP. Resolves the chosen option's `key`, or `null` on
 * Cancel / dismiss (Esc / click-outside / ✕).
 *
 * Usage:
 *   const choice = await choiceDialog({
 *     title: "Add this file?",
 *     message: "…",
 *     options: [{ key: "merge", label: "Merge", primary: true }, { key: "new", label: "New window" }],
 *   });
 *   if (choice === "merge") { … }
 */

import { create } from "zustand";

export interface ChoiceOption {
  /** Value returned by `choiceDialog` when this option is picked. */
  key: string;
  /** Button label. */
  label: string;
  /** Render as the primary (accent) button. */
  primary?: boolean;
}

export interface ChoiceRequest {
  /** Header text (default "Choose an action"). */
  title?: string;
  /** Body — `\n` renders as line breaks. */
  message: string;
  /** Action buttons (in order). A Cancel button is always shown alongside. */
  options: ChoiceOption[];
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
}

interface ChoiceStore {
  request: ChoiceRequest | null;
  /** Show the modal; resolves the chosen option key, or null on cancel/dismiss. */
  choose: (req: ChoiceRequest) => Promise<string | null>;
  /** Answer the active request (from the dialog buttons / dismiss). */
  respond: (key: string | null) => void;
}

// Single pending resolver — prompts are sequential; a new request supersedes any
// pending one (resolved null). Not render state, so kept out of the store.
let resolver: ((key: string | null) => void) | null = null;

export const useChoiceStore = create<ChoiceStore>((set) => ({
  request: null,
  choose: (req) =>
    new Promise<string | null>((resolve) => {
      resolver?.(null); // supersede any prior pending prompt
      resolver = resolve;
      set({ request: req });
    }),
  respond: (key) => {
    const r = resolver;
    resolver = null;
    set({ request: null });
    r?.(key);
  },
}));

/** Promise-based multi-choice prompt. Resolves the chosen key, or `null` on cancel/dismiss. */
export function choiceDialog(req: ChoiceRequest): Promise<string | null> {
  return useChoiceStore.getState().choose(req);
}
