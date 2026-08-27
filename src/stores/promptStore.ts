/**
 * App-wide promise-based text-input prompt, rendered as an in-WebView React
 * modal ({@link import("@/components/dialogs/PromptDialog").PromptDialog})
 * styled to match SLEAP — the replacement for `window.prompt`.
 *
 * Why not `window.prompt`: in the Tauri WebView it is not implemented (returns
 * null / no-op), so any feature relying on it silently fails on the desktop
 * app. This helper gives one consistent, styled input prompt in the browser AND
 * desktop. Mirrors {@link import("@/stores/confirmStore").confirmDialog}.
 *
 * Usage: `const v = await promptDialog({ message: "…" }); if (v === null) return;`
 */

import { create } from "zustand";

export interface PromptRequest {
  /** Header text (default "Enter a value"). */
  title?: string;
  /** Body / field label — `\n` renders as line breaks. */
  message: string;
  /** Pre-filled input value. */
  defaultValue?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Confirm button label (default "OK"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
}

interface PromptStore {
  request: PromptRequest | null;
  /** Show the modal; resolves the entered string, or null on cancel/dismiss. */
  prompt: (req: PromptRequest) => Promise<string | null>;
  /** Answer the active request (from the dialog buttons / dismiss). */
  respond: (value: string | null) => void;
}

// Single pending resolver — prompts are sequential; a new request supersedes any
// pending one (resolved null). Not render state, so kept out of the store.
let resolver: ((value: string | null) => void) | null = null;

export const usePromptStore = create<PromptStore>((set) => ({
  request: null,
  prompt: (req) =>
    new Promise<string | null>((resolve) => {
      resolver?.(null); // supersede any prior pending prompt
      resolver = resolve;
      set({ request: req });
    }),
  respond: (value) => {
    const r = resolver;
    resolver = null;
    set({ request: null });
    r?.(value);
  },
}));

/** Promise-based text prompt. Resolves the entered string, or null on cancel. */
export function promptDialog(req: PromptRequest): Promise<string | null> {
  return usePromptStore.getState().prompt(req);
}
