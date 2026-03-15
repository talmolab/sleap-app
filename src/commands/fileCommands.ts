/**
 * File commands: New, Open, Save, Export, Delete Predictions.
 *
 * Ports SLEAP's NewProject, OpenProject, SaveProject commands and adds
 * CSV export, JSON save-as, prediction deletion variants, and package export.
 */

import { Labels, PredictedInstance } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { loadProjectFromFile, loadProjectFromPath } from "../lib/loadProject";
import { saveProjectAsSlp } from "../lib/saveProject";
import { getPlatform } from "../platform/index";
import {
  generateCSV,
  downloadFile,
  suggestSaveFilename,
  generatePackageJSON,
} from "../lib/exportUtils";
import { toast } from "@/lib/notify";

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

    const labels = new Labels();
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
    const result = await platform.showOpenDialog({
      filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
    });

    if (!result) return;

    if (typeof result === "string" && !Array.isArray(result)) {
      // Tauri: got a file path
      await loadProjectFromPath(result, platform.readFile, platform.exists);
    } else if (result instanceof File) {
      // Browser: got a File object
      await loadProjectFromFile(result);
    }

    // OpenProject sets labels directly via load helpers,
    // so we don't need to signal topics (setLabels handles it)
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
    const { labels } = ctx.state;
    if (!labels) return;
    // Pass no filename so the picker always shows with default "labels.slp"
    await saveProjectAsSlp(labels);
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

/** Export all labels data as a CSV file for analysis. */
export const ExportCSVCommand: Command = {
  name: "ExportCSV",
  topics: [],
  execute(ctx: CommandContext) {
    const { labels, filename } = ctx.state;
    if (!labels) return;

    try {
      const csv = generateCSV(labels);
      const baseName = filename
        ? filename.replace(/\.slp$/, "").replace(/\.json$/, "")
        : "labels";
      downloadFile(csv, `${baseName}.csv`, "text/csv");
      toast.success("CSV exported", {
        description: `${baseName}.csv`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Failed to export CSV", { description: msg });
      console.error("[ExportCSV] Failed to export:", err);
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
      const platform = await getPlatform();

      if (platform.isTauri) {
        const savePath = await platform.showSaveDialog({
          filters: [{ name: "JSON", extensions: ["json"] }],
          defaultName: suggestedName,
        });
        if (!savePath) return;
        const encoder = new TextEncoder();
        await platform.writeFile(savePath, encoder.encode(json));
        ctx.state.clearChanges();
        toast.success("JSON saved", { description: savePath });
      } else if ("showSaveFilePicker" in window) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handle = await (window as any).showSaveFilePicker({
            suggestedName,
            types: [
              {
                description: "JSON File",
                accept: { "application/json": [".json"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(json);
          await writable.close();
          ctx.state.clearChanges();
          toast.success("JSON saved", { description: handle.name });
        } catch {
          // User cancelled
          return;
        }
      } else {
        // Fallback: simple download
        downloadFile(json, suggestedName, "application/json");
        ctx.state.clearChanges();
        toast.success("JSON saved", { description: suggestedName });
      }
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
