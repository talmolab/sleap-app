import { isTauri } from "@/platform/index";

/** Open a URL in the system browser (desktop) or a new tab (web). */
export async function openExternal(url: string) {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } else {
    window.open(url, "_blank");
  }
}
