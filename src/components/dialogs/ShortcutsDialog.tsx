/**
 * Keyboard Shortcuts Dialog.
 *
 * Displays all keyboard shortcuts grouped by category in a table format.
 */

import { DEFAULT_SHORTCUTS } from "../../lib/shortcuts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Map shortcut key codes to human-readable labels. */
function formatKey(key: string): string {
  return key
    .replace(/\$mod/g, navigator.platform.includes("Mac") ? "Cmd" : "Ctrl")
    .replace(/Key([A-Z])/g, "$1")
    .replace(/Digit(\d)/g, "$1")
    .replace(/Arrow(Right|Left|Up|Down)/g, (_, d) =>
      d === "Right" ? "\u2192" : d === "Left" ? "\u2190" : d === "Up" ? "\u2191" : "\u2193"
    )
    .replace(/Backquote/g, "`")
    .replace(/Backspace/g, "Backspace")
    .replace(/Escape/g, "Esc")
    .replace(/Tab/g, "Tab")
    .replace(/Space/g, "Space")
    .replace(/Equal/g, "=")
    .replace(/\+/g, " + ");
}

/** Shortcut categories and their entries. */
const CATEGORIES: Record<string, string[]> = {
  File: ["new", "open", "save", "save as", "close"],
  Navigation: [
    "frame next",
    "frame prev",
    "frame next medium step",
    "frame prev medium step",
    "frame next large step",
    "frame prev large step",
    "goto next labeled",
    "goto prev labeled",
    "goto next suggestion",
    "goto prev suggestion",
    "goto next user",
    "goto last interacted",
    "goto next track spawn",
    "goto frame",
    "next video",
    "prev video",
    "select next",
    "clear selection",
  ],
  Editing: [
    "add instance",
    "delete instance",
    "copy instance",
    "paste instance",
    "toggle node visibility",
  ],
  View: ["fit", "show instances", "show labels", "show edges", "toggle pan mode", "toggle place mode"],
  Tracks: [
    "transpose",
    "add track",
    "copy track",
    "paste track",
  ],
};

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {Object.entries(CATEGORIES).map(([category, keys]) => (
            <div key={category}>
              <h3 className="text-sm font-semibold mb-1 text-muted-foreground">
                {category}
              </h3>
              <table className="w-full text-sm">
                <tbody>
                  {keys.map((key) => {
                    const binding = DEFAULT_SHORTCUTS[key];
                    if (!binding) return null;
                    return (
                      <tr
                        key={key}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="py-1 capitalize">{key}</td>
                        <td className="py-1 text-right">
                          <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded font-mono">
                            {formatKey(binding)}
                          </kbd>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
