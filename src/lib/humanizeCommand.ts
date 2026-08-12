/**
 * Turn an internal command name (PascalCase identifier, e.g. `MergeIntoProject`)
 * into a human-readable label (`Merge Into Project`) for undo/redo feedback — the
 * toast on ⌘Z/⌘⇧Z and the Edit-menu "Undo …" / "Redo …" labels.
 */
export function humanizeCommandName(name: string): string {
  if (!name) return "";
  return name
    // boundary between a lower/digit and an upper: "mergeInto" -> "merge Into"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // acronym boundary: "HTTPServer" -> "HTTP Server"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}
