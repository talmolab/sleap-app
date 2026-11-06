/**
 * Which shortcuts the native menu currently owns (as accelerators), so the
 * app's own key handler (useKeyboardShortcuts) can leave them alone instead
 * of running the command a second time. Empty unless the native menu is in
 * use (macOS desktop).
 */

let owned = new Set<string>();

export function setNativeMenuShortcuts(bindings: Iterable<string>): void {
  owned = new Set(bindings);
}

export function isNativeMenuShortcut(binding: string): boolean {
  return owned.has(binding);
}
