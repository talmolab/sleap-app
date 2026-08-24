/**
 * Save a diagnostics bundle to a file the tester can send us.
 *
 * Desktop: native Save dialog → write JSON (the tester chooses the location, so
 * there's nothing to "reveal"). Browser: a blob download fallback. Delivery is
 * manual by design — no upload, no backend.
 */

import { collectDiagnostics } from "./collectDiagnostics";
import { toast } from "@/lib/notify";
import { isTauri } from "@/lib/platform";

function fileTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Collect + save a diagnostics bundle. Returns the saved path (desktop) or
 * filename (browser), or null if the user cancelled or it failed.
 */
export async function saveDiagnosticsBundle(opts: {
  includeProject: boolean;
}): Promise<string | null> {
  let json: string;
  try {
    json = JSON.stringify(await collectDiagnostics(opts), null, 2);
  } catch (e) {
    toast.error("Could not collect diagnostics", { description: String(e) });
    return null;
  }

  const defaultName = `sleap-app-diagnostics-${fileTimestamp()}.json`;

  if (!isTauri) {
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Diagnostics downloaded", { description: defaultName });
      return defaultName;
    } catch (e) {
      toast.error("Could not save diagnostics", { description: String(e) });
      return null;
    }
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "Diagnostics", extensions: ["json"] }],
    });
    if (!path) return null; // user cancelled the dialog
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, json);
    toast.success("Diagnostics saved", {
      description: "Send this file to the SLEAP team.",
    });
    return path;
  } catch (e) {
    toast.error("Could not save diagnostics", { description: String(e) });
    return null;
  }
}
