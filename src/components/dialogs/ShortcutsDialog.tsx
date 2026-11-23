/**
 * Keyboard Shortcuts Dialog (Help ▸ Keyboard Shortcuts…), as in PyQt SLEAP's
 * `dialogs/shortcuts.py`: every rebindable action grouped by category, each
 * with its key(s). Click a key to change it; a key another action already
 * has is moved here after a yes ("⌘K is used by Delete Area Predictions —
 * move it here?"), leaving that action without it. Changes take effect on
 * Save (everywhere: canvas keys, the menus and their native macOS
 * accelerators, Search Menus). Export… / Import… save and load them as a
 * shortcuts.yaml file, in PyQt's format.
 *
 * Below the editable list: the Label QC Review window's keys and the
 * canvas's mouse gestures, for reference.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { shortcutBindings, type ShortcutOverrides } from "@/lib/shortcuts";
import {
  SHORTCUT_CATEGORIES,
  actionLabel,
  assignShortcut,
  clearShortcut,
  defaultKeyConflicts,
  findConflict,
  isCustomized,
  keyFromEvent,
  resetShortcut,
} from "@/lib/shortcutEditing";
import {
  SHORTCUTS_FILE_NAME,
  describeMoves,
  exportShortcutsYaml,
  parseShortcutsYaml,
} from "@/lib/shortcutsFile";
import { formatShortcut } from "@/lib/formatShortcut";
import { CANVAS_GESTURES } from "@/lib/canvasGestures";
import { QC_REVIEW_KEYS } from "@/lib/qcReview";
import { downloadFile } from "@/lib/exportUtils";
import { toast } from "@/lib/notify";
import { getPlatform } from "@/platform/index";
import { useAppStore } from "@/stores/appStore";
import { confirmDialog } from "@/stores/confirmStore";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The keys of a binding list, or "None". */
function KeyChips({ bindings }: { bindings: string[] }) {
  if (bindings.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
  return (
    <>
      {bindings.map((binding, i) => (
        <span key={binding}>
          {i > 0 && <span className="mx-1 text-xs text-muted-foreground">or</span>}
          <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded font-mono">{formatShortcut(binding)}</kbd>
        </span>
      ))}
    </>
  );
}

/** Save a shortcuts file: native dialog on desktop, picker or download in a browser. */
async function saveShortcutsFile(text: string): Promise<string | null> {
  const platform = await getPlatform();
  if (platform.isTauri) {
    const path = await platform.showSaveDialog({
      filters: [{ name: "Shortcuts YAML", extensions: ["yaml", "yml"] }],
      defaultName: SHORTCUTS_FILE_NAME,
    });
    if (!path) return null;
    await platform.writeFile(path, new TextEncoder().encode(text));
    return path;
  }
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await (
        window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }
      ).showSaveFilePicker({
        types: [{ description: "Shortcuts YAML", accept: { "text/yaml": [".yaml", ".yml"] } }],
        suggestedName: SHORTCUTS_FILE_NAME,
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([text], { type: "text/yaml" }));
      await writable.close();
      return handle.name;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }
  downloadFile(text, SHORTCUTS_FILE_NAME, "text/yaml");
  return SHORTCUTS_FILE_NAME;
}

/** Pick a shortcuts file and read its text, or null if cancelled. */
async function readShortcutsFile(): Promise<string | null> {
  const platform = await getPlatform();
  const picked = await platform.showOpenDialog({
    filters: [{ name: "Shortcuts YAML", extensions: ["yaml", "yml"] }],
  });
  const one = Array.isArray(picked) ? picked[0] : picked;
  if (one == null) return null;
  if (typeof one === "string") return new TextDecoder().decode(await platform.readFile(one));
  return one.text();
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  // Edits go to a draft; Save applies them (as PyQt's dialog does).
  const [draft, setDraft] = useState<ShortcutOverrides>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  // The release of a captured key mustn't reach the app either (Space and
  // Shift+Space act on release).
  const swallowKeyUp = useRef(false);

  useEffect(() => {
    if (!open) return;
    setDraft(useAppStore.getState().shortcutOverrides);
    setCapturing(null);
    setMessage(null);
  }, [open]);

  const tryAssign = useCallback(async (action: string, key: string) => {
    const conflict = findConflict(draft, action, key);
    const shown = formatShortcut(key);
    if (conflict?.kind === "reserved") {
      setMessage({ text: `${shown} is reserved for ${conflict.label} and can't be used here. Pick another key.`, error: true });
      return;
    }
    if (conflict?.kind === "action") {
      const ok = await confirmDialog({
        title: "Shortcut in use",
        message: `${shown} is used by ${actionLabel(conflict.action)} — move it here?`,
        confirmLabel: "Move",
      });
      if (!ok) return;
      setMessage({ text: `${shown} moved from ${actionLabel(conflict.action)} to ${actionLabel(action)}.` });
    } else {
      setMessage(null);
    }
    setDraft((d) => assignShortcut(d, action, key));
  }, [draft]);

  // While waiting for a key the menus own no shortcuts: on macOS the native
  // menu would otherwise take its ⌘ keys (e.g. ⌘K runs Delete Predictions
  // from Area…) before the page sees them.
  useEffect(() => {
    useAppStore.getState().set("shortcutCaptureActive", capturing !== null);
    return () => useAppStore.getState().set("shortcutCaptureActive", false);
  }, [capturing]);

  // While waiting for a key, take every key press before anything else on
  // the page sees it (the app's own shortcuts, the dialog's Esc-to-close).
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCapturing(null);
        return;
      }
      const key = keyFromEvent(e);
      if (!key) return; // only modifiers so far
      const action = capturing;
      swallowKeyUp.current = true;
      setCapturing(null);
      void tryAssign(action, key);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing, tryAssign]);

  useEffect(() => {
    if (!open) return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (!capturing && !swallowKeyUp.current) return;
      if (!capturing) swallowKeyUp.current = false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => window.removeEventListener("keyup", onKeyUp, { capture: true });
  }, [open, capturing]);

  const reset = async (action: string) => {
    const taken = defaultKeyConflicts(draft, action);
    if (taken.length > 0) {
      const list = taken.map((t) => `${formatShortcut(t.key)} is used by ${actionLabel(t.action)}`).join("\n");
      const ok = await confirmDialog({
        title: "Shortcut in use",
        message: `${list} — move it back to ${actionLabel(action)}?`,
        confirmLabel: "Move",
      });
      if (!ok) return;
    }
    setMessage(null);
    setDraft((d) => resetShortcut(d, action));
  };

  const save = () => {
    useAppStore.getState().set("shortcutOverrides", draft);
    onOpenChange(false);
    toast.success("Keyboard shortcuts saved");
  };

  const doExport = async () => {
    try {
      const where = await saveShortcutsFile(exportShortcutsYaml(draft));
      if (where) setMessage({ text: `Exported to ${where}.` });
    } catch (err) {
      setMessage({ text: `Couldn't export: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  const doImport = async () => {
    try {
      const text = await readShortcutsFile();
      if (text == null) return;
      const result = parseShortcutsYaml(text);
      setDraft(result.overrides);
      const lines = [
        `Imported ${result.count} shortcut${result.count === 1 ? "" : "s"}; the rest are the defaults. Save to keep them.`,
        ...describeMoves(result.moved, formatShortcut),
        ...(result.unknown.length ? [`Not in this app (ignored): ${result.unknown.join(", ")}`] : []),
        ...(result.invalid.length ? [`Couldn't use (ignored): ${result.invalid.join("; ")}`] : []),
      ];
      setMessage({ text: lines.join("\n") });
    } catch (err) {
      setMessage({ text: `Couldn't import: ${err instanceof Error ? err.message : String(err)}`, error: true });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Click a key to change it, then press the new key (Esc cancels).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 overflow-y-auto min-h-0 pr-1" data-testid="shortcuts-list">
          {Object.entries(SHORTCUT_CATEGORIES).map(([category, actions]) => (
            <div key={category}>
              <h3 className="text-sm font-semibold mb-1 text-muted-foreground">{category}</h3>
              <table className="w-full text-sm">
                <tbody>
                  {actions.map((action) => {
                    const bindings = shortcutBindings(action, draft);
                    const changed = isCustomized(draft, action);
                    return (
                      <tr key={action} className="border-b border-border/50 last:border-0" data-action={action}>
                        <td className={`py-1 ${changed ? "font-medium" : ""}`}>{actionLabel(action)}</td>
                        <td className="py-1 text-right whitespace-nowrap">
                          <button
                            type="button"
                            className="rounded px-1 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            title={`Change the key for ${actionLabel(action)}`}
                            onClick={() => {
                              setMessage(null);
                              setCapturing(capturing === action ? null : action);
                            }}
                          >
                            {capturing === action ? (
                              <span className="text-xs text-primary">Press a key…</span>
                            ) : (
                              <KeyChips bindings={bindings} />
                            )}
                          </button>
                        </td>
                        <td className="py-1 w-14 text-right whitespace-nowrap">
                          {bindings.length > 0 && (
                            <button
                              type="button"
                              className="p-0.5 text-muted-foreground hover:text-foreground"
                              title={`Remove the key from ${actionLabel(action)}`}
                              aria-label={`Clear ${actionLabel(action)}`}
                              onClick={() => {
                                setMessage(null);
                                setDraft((d) => clearShortcut(d, action));
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {changed && (
                            <button
                              type="button"
                              className="p-0.5 ml-1 text-muted-foreground hover:text-foreground"
                              title={`Back to the default (${shortcutBindings(action).map((k) => formatShortcut(k)).join(" or ") || "none"})`}
                              aria-label={`Reset ${actionLabel(action)}`}
                              onClick={() => void reset(action)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

          <div>
            <h3 className="text-sm font-semibold mb-1 text-muted-foreground">Label QC Review window</h3>
            <table className="w-full text-sm">
              <tbody>
                {QC_REVIEW_KEYS.map((k) => (
                  <tr key={k.action} className="border-b border-border/50 last:border-0">
                    <td className="py-1">{k.action}</td>
                    <td className="py-1 text-right">
                      <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded font-mono">{k.keys}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-1 text-muted-foreground">Canvas gestures</h3>
            <table className="w-full text-sm">
              <tbody>
                {CANVAS_GESTURES.map((g) => (
                  <tr key={`${g.modifiers}|${g.gesture}`} className="border-b border-border/50 last:border-0">
                    <td className="py-1">{g.action}</td>
                    <td className="py-1 text-right whitespace-nowrap">
                      {g.modifiers && (
                        <kbd className="px-1.5 py-0.5 mr-1 text-xs bg-muted rounded font-mono">
                          {formatShortcut(g.modifiers)}
                        </kbd>
                      )}
                      <span className="text-xs text-muted-foreground">{g.gesture}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {message && (
          <p
            className={`text-xs whitespace-pre-line ${message.error ? "text-destructive" : "text-muted-foreground"}`}
            role="status"
          >
            {message.text}
          </p>
        )}

        <DialogFooter className="sm:justify-between gap-2">
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft({});
                setMessage({ text: "All shortcuts set back to the defaults. Save to keep them." });
              }}
            >
              Reset to Defaults
            </Button>
            <Button variant="ghost" onClick={() => void doImport()}>
              Import…
            </Button>
            <Button variant="ghost" onClick={() => void doExport()}>
              Export…
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
