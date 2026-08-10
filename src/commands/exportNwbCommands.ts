/**
 * NWB (ndx-pose) export — Labels → `.nwb`.
 *
 * Writing spec-conformant NWB by hand (the `/specifications` schema cache, object
 * references, per-group `object_id`/`neurodata_type` bookkeeping) is a large,
 * risky h5wasm effort. Instead we reuse the Python we already run for
 * training/inference: the installed `sleap-nn` uv-tool env carries the full
 * `sleap-io` + `pynwb` + `ndx-pose` stack, so a one-liner
 * (`sio.save_file(sio.load_file(tmp.slp), out.nwb)`) produces a valid file with
 * zero new dependencies. The flow:
 *   1. serialize the current in-memory labels to a temp `.slp` (captures unsaved
 *      edits),
 *   2. hand both paths to the Rust `export_nwb` command, which resolves the
 *      sleap-nn venv Python (same interpreter as training/inference), runs the
 *      conversion, and removes the temp file.
 *
 * DESKTOP ONLY: the browser has no local Python. (Import stays a browser-capable
 * JS reader; the read=JS / write=Python split is safe because the on-disk
 * ndx-pose format is the contract — see the NWB import reader.)
 *
 * IMAGE-SEQUENCE limitation: the ndx-pose writer can't store image-sequence
 * videos (`RuntimeError: unable to write attribute 'starting_frame'` on the
 * list-valued `external_file`). This is a limitation of the shared SLEAP NWB
 * writer that PyQt SLEAP delegates to as well — not something we uniquely drop —
 * so we detect image-sequence projects up front and warn instead of surfacing a
 * raw Python traceback.
 */

import { saveSlpToBytes } from "@talmolab/sleap-io.js";
import type { Labels } from "@talmolab/sleap-io.js";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { getPlatform } from "../platform/index";
import { exportNwb as invokeExportNwb } from "../platform/backend";
import { isImageSequenceVideo } from "@/lib/resolveVideos";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";

/**
 * Derive the `.nwb` output filename from the current project filename. Strips a
 * trailing `.pkg.slp` / `.slp` / `.json` / `.nwb`, keeping the directory portion,
 * then appends `.nwb`. e.g. `"session.slp"` → `"session.nwb"`,
 * `"x.pkg.slp"` → `"x.nwb"`, `null` → `"labels.nwb"`.
 */
export function deriveNwbFilename(filename: string | null): string {
  const base = (filename ?? "labels")
    .replace(/\.pkg\.slp$/i, "")
    .replace(/\.slp$/i, "")
    .replace(/\.json$/i, "")
    .replace(/\.nwb$/i, "");
  return `${base}.nwb`;
}

/**
 * The temp `.slp` handoff path for a chosen `.nwb` output. Written next to the
 * output (a directory the user just picked to save into, so it's writable) and
 * MUST end in `.slp` so Python's `sio.load_file` infers the SLP format. The Rust
 * side removes it after the conversion.
 */
export function tempSlpPathFor(nwbPath: string): string {
  return `${nwbPath.replace(/\.nwb$/i, "")}.export.tmp.slp`;
}

/**
 * Whether any video in the project is an image sequence (which the ndx-pose
 * writer can't store — see the module doc). Uses the same classifier the video
 * resolver uses, so it catches list filenames, single image-extension names, and
 * the loader's `image-sequence` backendError.
 */
export function hasImageSequenceVideo(labels: Labels): boolean {
  return labels.videos.some((v) => isImageSequenceVideo(v));
}

/**
 * Recognize the "sleap-nn environment is missing" failure so the UI can prompt
 * the user to install it (rather than showing a raw error). Matches both the Rust
 * sentinel (`SLEAP_NN_NOT_INSTALLED`) and the resolver's human message, and does
 * so via substring so a wrapping invoke-error envelope still matches.
 */
export function isSleapNnMissingError(message: string): boolean {
  return (
    message.includes("SLEAP_NN_NOT_INSTALLED") ||
    message.includes("sleap-nn environment not found")
  );
}

/**
 * Export the current project to NWB (ndx-pose) via the sleap-nn env's sleap-io.
 * Desktop only; guards empty projects and image-sequence videos; prompts to
 * install sleap-nn when the environment is missing.
 */
export const ExportNwbCommand: Command = {
  name: "ExportNwb",
  topics: [],
  async execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    const platform = await getPlatform();
    if (!platform.isTauri) {
      toast.info("NWB export needs the desktop app", {
        description:
          "Writing NWB runs a local sleap-nn Python environment, which isn't " +
          "available in the browser.",
      });
      return;
    }

    if (labels.labeledFrames.length === 0) {
      toast.info("No labeled frames to export.");
      return;
    }

    if (hasImageSequenceVideo(labels)) {
      toast.warning("NWB export doesn't support image-sequence projects", {
        description:
          "The NWB (ndx-pose) writer can't store image-sequence videos — a " +
          "limitation of the shared SLEAP NWB format, not just this app.",
      });
      return;
    }

    const nwbPath = await platform.showSaveDialog({
      filters: [{ name: "NWB (ndx-pose)", extensions: ["nwb"] }],
      defaultName: deriveNwbFilename(filename),
    });
    if (!nwbPath) return; // user cancelled

    const tmpSlp = tempSlpPathFor(nwbPath);
    try {
      // Serialize the CURRENT labels (incl. unsaved edits) to a plain .slp (no
      // embed — NWB references the video by path, no pixels). Written next to the
      // chosen output; the Rust command removes it after converting.
      const bytes = await saveSlpToBytes(labels);
      await platform.writeFile(tmpSlp, bytes);
      await invokeExportNwb(tmpSlp, nwbPath);
      toast.success("NWB exported", { description: nwbPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSleapNnMissingError(msg)) {
        toast.error("Install sleap-nn in the Environment to export NWB", {
          description: "Open the Environment tab to install it.",
          action: {
            label: "Open Environment",
            onClick: () => useAppStore.getState().openPanel("environment"),
          },
        });
      } else {
        toast.error("Failed to export NWB", { description: msg });
      }
      console.error("[ExportNwb] Failed to export:", err);
    }
  },
};
