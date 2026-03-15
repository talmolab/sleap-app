/** Browser stub for @tauri-apps/plugin-fs (only available in Tauri runtime). */
export async function readFile(_path: string): Promise<Uint8Array> {
  throw new Error("readFile is only available in Tauri runtime");
}
export async function writeFile(_path: string, _data: Uint8Array): Promise<void> {
  throw new Error("writeFile is only available in Tauri runtime");
}
export async function exists(_path: string): Promise<boolean> {
  return false;
}
