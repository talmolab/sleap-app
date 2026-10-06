/**
 * Save the QC anomaly results as a CSV file.
 *
 * Desktop (Tauri): native Save dialog -> writeTextFile. Browser: a Blob
 * download. Mirrors saveDiagnostics.ts's dual-path delivery. Returns the saved
 * path (desktop) / filename (browser), or null if cancelled or failed.
 */
import { toast } from "@/lib/notify";
import { isTauri } from "@/lib/platform";

export async function saveQcCsv(
  csv: string,
  defaultName = "qc_results.csv",
): Promise<string | null> {
  if (!isTauri) {
    try {
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("QC results downloaded", { description: defaultName });
      return defaultName;
    } catch (e) {
      toast.error("Could not export QC results", { description: String(e) });
      return null;
    }
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return null; // user cancelled the dialog
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, csv);
    toast.success("QC results saved", { description: path });
    return path;
  } catch (e) {
    toast.error("Could not export QC results", { description: String(e) });
    return null;
  }
}
