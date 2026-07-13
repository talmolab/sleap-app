/**
 * File commands: New, Open, Save, Export, Delete Predictions.
 *
 * Ports SLEAP's NewProject, OpenProject, SaveProject commands and adds
 * CSV export, JSON save-as, prediction deletion variants, and package export.
 */

import {
  Labels,
  PredictedInstance,
  Skeleton,
  labelsToCsv,
  saveAnalysisH5ToBytes,
} from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import {
  loadProjectFromFile,
  loadProjectFromPath,
  loadAnalysisProjectFromFile,
  loadAnalysisProjectFromPath,
} from "../lib/loadProject";
import { saveProjectAsSlp } from "../lib/saveProject";
import { getPlatform } from "../platform/index";
import {
  downloadFile,
  suggestSaveFilename,
  generatePackageJSON,
} from "../lib/exportUtils";
import { toast } from "@/lib/notify";

/**
 * Save text to a user-chosen location. Tauri: native save dialog + writeFile.
 * Browser: File System Access `showSaveFilePicker` when available, else a plain
 * download. Returns the saved path/name, or null if the user cancelled.
 */
async function saveTextFile(
  content: string,
  suggestedName: string,
  filter: { name: string; ext: string; mime: string }
): Promise<string | null> {
  const platform = await getPlatform();

  if (platform.isTauri) {
    const savePath = await platform.showSaveDialog({
      filters: [{ name: filter.name, extensions: [filter.ext] }],
      defaultName: suggestedName,
    });
    if (!savePath) return null;
    await platform.writeFile(savePath, new TextEncoder().encode(content));
    return savePath;
  }

  if ("showSaveFilePicker" in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: filter.name,
            accept: { [filter.mime]: [`.${filter.ext}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name as string;
    } catch {
      return null; // user cancelled the picker
    }
  }

  downloadFile(content, suggestedName, filter.mime);
  return suggestedName;
}

/**
 * Save binary content to a user-chosen location. Tauri: native save dialog +
 * writeFile. Browser: File System Access `showSaveFilePicker` when available,
 * else a download. Returns the saved path/name, or null if the user cancelled.
 */
async function saveBytesFile(
  bytes: Uint8Array,
  suggestedName: string,
  filter: { name: string; ext: string }
): Promise<string | null> {
  const platform = await getPlatform();

  if (platform.isTauri) {
    const savePath = await platform.showSaveDialog({
      filters: [{ name: filter.name, extensions: [filter.ext] }],
      defaultName: suggestedName,
    });
    if (!savePath) return null;
    await platform.writeFile(savePath, bytes);
    return savePath;
  }

  const blob = new Blob([bytes], { type: "application/octet-stream" });
  if ("showSaveFilePicker" in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: filter.name,
            accept: { "application/octet-stream": [`.${filter.ext}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name as string;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  downloadFile(blob, suggestedName, "application/octet-stream");
  return suggestedName;
}

/** Reset state to an empty project. */
export const NewProjectCommand: Command = {
  name: "NewProject",
  topics: [UpdateTopic.Project, UpdateTopic.Labels],
  execute(ctx: CommandContext) {
    // Check for unsaved changes before creating a new project
    if (ctx.state.hasChanges) {
      const confirmed = window.confirm(
        "You have unsaved changes. Creating a new project will discard them. Continue?"
      );
      if (!confirmed) return;
    }

    // Seed an empty skeleton so the editor lands in a usable state: the
    // Skeleton panel (and its template dropdown) require a non-null skeleton —
    // without one, New Project dead-ends on "No skeleton loaded" with no way to
    // add nodes. With a 0-node skeleton present, the user can pick a template
    // or add nodes, then add a video, and build a project from scratch. (#138)
    const skeleton = new Skeleton({ nodes: [], name: "skeleton" });
    const labels = new Labels({ skeletons: [skeleton] });
    ctx.state.setLabels(labels, undefined);
  },
};

/** Open a file dialog, load an SLP file, and set state. */
export const OpenProjectCommand: Command = {
  name: "OpenProject",
  topics: [],
  skipAutoSnapshot: true,
  async execute(ctx: CommandContext) {
    const platform = await getPlatform();
    console.log(`[open] Opening project via ${platform.isTauri ? "Tauri" : "browser"} dialog`);
    const result = await platform.showOpenDialog({
      filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
      excludeAcceptAll: true,
    });

    if (!result) return;

    if (typeof result === "string") {
      console.log(`[open] Loading from path: ${result}`);
      await loadProjectFromPath(result, platform.readFile, platform.exists);
    } else if (result instanceof File) {
      console.log(`[open] Loading from File object: ${result.name} (${result.size} bytes)`);
      await loadProjectFromFile(result);
    }

    // OpenProject sets labels directly via load helpers,
    // so we don't need to signal topics (setLabels handles it)
    void ctx;
  },
};

/**
 * Import a SLEAP Analysis HDF5 (`.analysis.h5`) file as a new project.
 *
 * Analysis files carry predicted points + tracks and store the source
 * `video_path`, so the reader auto-builds the video (resolved like any external
 * video). Filtered to `.h5` in the picker; the reader validates the contents.
 */
export const ImportAnalysisH5Command: Command = {
  name: "ImportAnalysisH5",
  topics: [],
  skipAutoSnapshot: true,
  async execute(ctx: CommandContext) {
    const platform = await getPlatform();
    const result = await platform.showOpenDialog({
      filters: [{ name: "SLEAP Analysis HDF5", extensions: ["h5"] }],
    });

    if (!result) return;

    if (typeof result === "string") {
      await loadAnalysisProjectFromPath(result, platform.readFile, platform.exists);
    } else if (result instanceof File) {
      await loadAnalysisProjectFromFile(result);
    }

    void ctx;
  },
};

/** Save the project as SLP (HDF5). */
export const SaveProjectCommand: Command = {
  name: "SaveProject",
  topics: [],
  async execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;
    await saveProjectAsSlp(labels, filename ?? undefined);
  },
};

/** Save the project as SLP, always showing the file picker. */
export const SaveAsProjectCommand: Command = {
  name: "SaveAsProject",
  topics: [],
  async execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;
    await saveProjectAsSlp(labels, filename ?? undefined, true);
  },
};

/** Export the current project as JSON (toDict() serialization). */
export const ExportJsonCommand: Command = {
  name: "ExportJson",
  topics: [],
  execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    try {
      const dict = labels.toDict();
      const json = JSON.stringify(dict, null, 2);
      const baseName = filename
        ? filename.replace(/\.slp$/, "")
        : "labels";
      downloadFile(json, `${baseName}.json`, "application/json");
      toast.success("JSON exported", {
        description: `${baseName}.json`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to export JSON", { description: msg });
      console.error("[ExportJson] Failed to export:", err);
    }
  },
};

/**
 * Export the project as a SLEAP Analysis CSV via sleap-io's canonical
 * `labelsToCsv` (wide format: one row per instance per frame, alphabetical
 * `{node}.x/.y/.score` columns) — parity with Python SLEAP's analysis CSV,
 * replacing the app's earlier hand-rolled long-format exporter. Saves through a
 * native dialog on desktop; downloads in the browser.
 */
export const ExportCSVCommand: Command = {
  name: "ExportCSV",
  topics: [],
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    // Default includeEmpty=true (NaN rows padding each video to its full span),
    // matching the Export dialog default and Python's analysis export.
    const includeEmpty = params?.includeEmpty !== false;

    try {
      const csv = labelsToCsv(labels, { includeEmpty });
      const baseName = filename
        ? filename.replace(/\.(slp|json)$/i, "")
        : "labels";
      const saved = await saveTextFile(csv, `${baseName}.csv`, {
        name: "CSV",
        ext: "csv",
        mime: "text/csv",
      });
      if (!saved) return; // user cancelled
      toast.success("CSV exported", { description: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to export CSV", { description: msg });
      console.error("[ExportCSV] Failed to export:", err);
    }
  },
};

/**
 * Export the active video's tracks as a SLEAP Analysis HDF5 (.h5) file — the
 * dense-array format for downstream analysis (Python/MATLAB). Uses sleap-io's
 * browser-safe `saveAnalysisH5ToBytes`; saves through a native dialog on desktop,
 * downloads in the browser. One file per video (the current video), mirroring
 * PyQt SLEAP's "Analysis HDF5 > Current Video".
 */
export const ExportAnalysisH5Command: Command = {
  name: "ExportAnalysisH5",
  topics: [],
  async execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;
    if (labels.labeledFrames.length === 0) {
      toast.info("No labeled frames to export.");
      return;
    }

    try {
      // Export the current video when one is active, else the first video.
      // saveAnalysisH5ToBytes throws "No labeled frames in video" if the chosen
      // video has none — surfaced as a friendly error below.
      const video = ctx.state.video ?? labels.videos[0];
      const bytes = await saveAnalysisH5ToBytes(labels, { video });
      const baseName = filename
        ? filename.replace(/\.(slp|json)$/i, "")
        : "labels";
      const saved = await saveBytesFile(bytes, `${baseName}.analysis.h5`, {
        name: "Analysis HDF5",
        ext: "h5",
      });
      if (!saved) return; // user cancelled
      toast.success("Analysis HDF5 exported", { description: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to export Analysis HDF5", { description: msg });
      console.error("[ExportAnalysisH5] Failed to export:", err);
    }
  },
};

/** Save the project as JSON with a file picker and version numbering. */
export const SaveAsJsonCommand: Command = {
  name: "SaveAsJson",
  topics: [],
  async execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    try {
      const dict = labels.toDict();
      const json = JSON.stringify(dict, null, 2);
      const suggestedName = suggestSaveFilename(filename);
      const saved = await saveTextFile(json, suggestedName, {
        name: "JSON",
        ext: "json",
        mime: "application/json",
      });
      if (!saved) return; // user cancelled
      ctx.state.clearChanges();
      toast.success("JSON saved", { description: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to save JSON", { description: msg });
      console.error("[SaveAsJson] Failed to save:", err);
    }
  },
};

// ---------------------------------------------------------------------------
// Delete Prediction Variants
// ---------------------------------------------------------------------------

/** Delete predicted instances with score below a threshold. */
export const DeletePredictionsByScore: Command = {
  name: "DeletePredictionsByScore",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels) return;
    const threshold =
      typeof params?.threshold === "number" ? params.threshold : 0.5;

    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictionsByScore");
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      const before = lf.instances.length;
      lf.instances = lf.instances.filter((inst) => {
        if (inst instanceof PredictedInstance) {
          return inst.score >= threshold;
        }
        return true;
      });
      removed += before - lf.instances.length;
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No predictions matched the filter.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: `Score threshold: < ${threshold}`,
    });
  },
};

/** Delete predicted instances within a frame range. */
export const DeletePredictionsByRange: Command = {
  name: "DeletePredictionsByRange",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels) return;
    const startFrame =
      typeof params?.startFrame === "number" ? params.startFrame : 0;
    const endFrame =
      typeof params?.endFrame === "number" ? params.endFrame : Infinity;

    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictionsByRange");
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      if (lf.frameIdx >= startFrame && lf.frameIdx <= endFrame) {
        const before = lf.instances.length;
        lf.instances = lf.instances.filter(
          (inst) => !(inst instanceof PredictedInstance)
        );
        removed += before - lf.instances.length;
      }
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No predictions found in the specified range.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: `Frames ${startFrame} to ${endFrame}`,
    });
  },
};

/** Delete predicted instances on frames that also have user instances. */
export const DeletePredictionsOnLabeledFrames: Command = {
  name: "DeletePredictionsOnLabeledFrames",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext) {
    const { labels, instance } = ctx.state;
    if (!labels) return;

    const snapshot = ctx.takeAllFramesSnapshot(
      "DeletePredictionsOnLabeledFrames"
    );
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      const hasUser = lf.instances.some(
        (inst) => !(inst instanceof PredictedInstance)
      );
      if (hasUser) {
        const before = lf.instances.length;
        lf.instances = lf.instances.filter(
          (inst) => !(inst instanceof PredictedInstance)
        );
        removed += before - lf.instances.length;
      }
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No predictions found on user-labeled frames.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: "On frames with user labels",
    });
  },
};

/** Keep only the top N predicted instances per frame by score. */
export const DeletePredictionsByMaxCount: Command = {
  name: "DeletePredictionsByMaxCount",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels) return;
    const maxInstances =
      typeof params?.maxInstances === "number" ? params.maxInstances : 2;

    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictionsByMaxCount");
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      const predicted = lf.instances.filter(
        (inst) => inst instanceof PredictedInstance
      ) as PredictedInstance[];
      const user = lf.instances.filter(
        (inst) => !(inst instanceof PredictedInstance)
      );

      if (predicted.length > maxInstances) {
        // Sort by score descending, keep top N
        predicted.sort((a, b) => b.score - a.score);
        const kept = predicted.slice(0, maxInstances);
        removed += predicted.length - maxInstances;
        lf.instances = [...user, ...kept];
      }
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No predictions exceeded the max count.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: `Kept top ${maxInstances} per frame`,
    });
  },
};

// ---------------------------------------------------------------------------
// Delete Predictions by Area (current frame only)
// ---------------------------------------------------------------------------

/** Compute the centroid of an instance's visible points. */
function computeCentroid(
  instance: { points: Array<{ xy: [number, number]; visible: boolean }> }
): [number, number] | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const p of instance.points) {
    if (p.visible && !isNaN(p.xy[0]) && !isNaN(p.xy[1])) {
      sumX += p.xy[0];
      sumY += p.xy[1];
      count++;
    }
  }
  if (count === 0) return null;
  return [sumX / count, sumY / count];
}

/** Delete predicted instances whose centroid falls within a rectangle on the current frame. */
export const DeletePredictionsByArea: Command = {
  name: "DeletePredictionsByArea",
  topics: [UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, labeledFrame, instance } = ctx.state;
    if (!labels || !labeledFrame) return;

    const x1 = typeof params?.x1 === "number" ? params.x1 : 0;
    const y1 = typeof params?.y1 === "number" ? params.y1 : 0;
    const x2 = typeof params?.x2 === "number" ? params.x2 : 0;
    const y2 = typeof params?.y2 === "number" ? params.y2 : 0;

    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictionsByArea");
    let removed = 0;

    const before = labeledFrame.instances.length;
    labeledFrame.instances = labeledFrame.instances.filter((inst) => {
      if (!(inst instanceof PredictedInstance)) return true;
      const centroid = computeCentroid(inst);
      if (!centroid) return true;
      const [cx, cy] = centroid;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        return false; // Remove
      }
      return true;
    });
    removed = before - labeledFrame.instances.length;

    // Remove empty labeled frames
    if (labeledFrame.instances.length === 0) {
      labels.labeledFrames = labels.labeledFrames.filter(
        (lf) => lf !== labeledFrame
      );
    }

    if (removed === 0) {
      toast.info("No predictions found in the selected area.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: "From selected area on current frame",
    });
  },
};

// ---------------------------------------------------------------------------
// Delete Predictions by Track
// ---------------------------------------------------------------------------

/** Delete predicted instances on a specific track (or untracked). */
export const DeletePredictionsByTrack: Command = {
  name: "DeletePredictionsByTrack",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels) return;

    // trackName: string | null (null means untracked)
    const trackName = params?.trackName as string | null | undefined;

    const snapshot = ctx.takeAllFramesSnapshot("DeletePredictionsByTrack");
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      const before = lf.instances.length;
      lf.instances = lf.instances.filter((inst) => {
        if (!(inst instanceof PredictedInstance)) return true;
        if (trackName === null || trackName === undefined) {
          // Delete untracked
          return inst.track !== null;
        }
        return inst.track?.name !== trackName;
      });
      removed += before - lf.instances.length;
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No predictions matched the track filter.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance && instance instanceof PredictedInstance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} prediction(s)`, {
      description: trackName ? `Track: ${trackName}` : "Untracked instances",
    });
  },
};

// ---------------------------------------------------------------------------
// Delete Instances by Type
// ---------------------------------------------------------------------------

/** Delete instances by type: "predicted", "user", or "all". */
export const DeleteInstancesByType: Command = {
  name: "DeleteInstancesByType",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels) return;

    const instanceType = (params?.instanceType as string) ?? "predicted";

    const snapshot = ctx.takeAllFramesSnapshot("DeleteInstancesByType");
    let removed = 0;

    for (const lf of labels.labeledFrames) {
      const before = lf.instances.length;
      lf.instances = lf.instances.filter((inst) => {
        if (instanceType === "predicted") {
          return !(inst instanceof PredictedInstance);
        } else if (instanceType === "user") {
          return inst instanceof PredictedInstance;
        } else {
          // "all" — remove everything
          return false;
        }
      });
      removed += before - lf.instances.length;
    }

    labels.labeledFrames = labels.labeledFrames.filter(
      (lf) => lf.instances.length > 0
    );

    if (removed === 0) {
      toast.info("No instances matched the type filter.");
      return;
    }

    ctx.pushUndoSnapshot(snapshot);

    if (instance) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${removed} instance(s)`, {
      description: `Type: ${instanceType}`,
    });
  },
};

// ---------------------------------------------------------------------------
// Export Package
// ---------------------------------------------------------------------------

/** Export a self-contained labels package as JSON. */
export const ExportPackageCommand: Command = {
  name: "ExportPackage",
  topics: [],
  execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    try {
      const packageJson = generatePackageJSON(labels);
      const baseName = filename
        ? filename.replace(/\.slp$/, "").replace(/\.json$/, "")
        : "labels";
      downloadFile(
        packageJson,
        `${baseName}.pkg.json`,
        "application/json"
      );
      toast.success("Package exported", {
        description: `${baseName}.pkg.json`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to export package", { description: msg });
      console.error("[ExportPackage] Failed to export:", err);
    }
  },
};
