/** Browser stub for @tauri-apps/plugin-dialog (only available in Tauri runtime). */
export async function open(_options?: unknown): Promise<string | null> {
  throw new Error("open dialog is only available in Tauri runtime");
}
export async function save(_options?: unknown): Promise<string | null> {
  throw new Error("save dialog is only available in Tauri runtime");
}

// confirm/ask/message have browser equivalents — fall back to the native window
// dialogs so callers (e.g. the plugin's confirm()) work in the browser build too.
export async function confirm(
  message: string,
  _options?: unknown
): Promise<boolean> {
  return window.confirm(message);
}
export async function ask(
  message: string,
  _options?: unknown
): Promise<boolean> {
  return window.confirm(message);
}
export async function message(
  msg: string,
  _options?: unknown
): Promise<void> {
  window.alert(msg);
}
