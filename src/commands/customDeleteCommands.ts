/**
 * Labels ▸ Custom Instance Delete... (PyQt `DeleteDialog.delete`).
 */

import type { Instance, LabeledFrame, Track } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { toast } from "@/lib/notify";
import { frameHasContent } from "@/lib/frameLabeling";
import {
  customDeleteTargets,
  trackInUse,
  type CustomDeleteChoice,
} from "@/lib/customInstanceDelete";

/**
 * Delete every instance the dialog's choice matches, as one undo step.
 *
 * Afterwards, like PyQt's `labels.clean()`: frames this left with nothing in
 * them are dropped (negative and otherwise-annotated frames stay), and tracks
 * whose last instance was deleted here are removed. Unused skeletons are NOT
 * removed (PyQt's clean would, leaving a project with no skeleton to label).
 *
 * Params: a {@link CustomDeleteChoice}.
 */
export const DeleteInstancesCustom: Command = {
  name: "DeleteInstancesCustom",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance, UpdateTopic.Tracks],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx, frameRange, instance } = ctx.state;
    const choice = params as unknown as CustomDeleteChoice | undefined;
    if (!labels || !choice) return;

    const targets = customDeleteTargets(labels, { video, frameIdx, frameRange }, choice);
    if (targets.length === 0) {
      toast.info("No instances match.");
      return;
    }

    const snapshot = ctx.takeAllFramesSnapshot("DeleteInstancesCustom");

    const byFrame = new Map<LabeledFrame, Set<Instance>>();
    const touchedTracks = new Set<Track>();
    for (const [lf, inst] of targets) {
      let set = byFrame.get(lf);
      if (!set) byFrame.set(lf, (set = new Set()));
      set.add(inst);
      if (inst.track) touchedTracks.add(inst.track);
    }
    const emptied = new Set<LabeledFrame>();
    for (const [lf, doomed] of byFrame) {
      lf.instances = lf.instances.filter((inst) => !doomed.has(inst));
      if (!frameHasContent(lf)) emptied.add(lf);
    }
    if (emptied.size > 0) {
      labels.labeledFrames = labels.labeledFrames.filter((lf) => !emptied.has(lf));
    }
    const unused = [...touchedTracks].filter((t) => !trackInUse(labels, t));
    if (unused.length > 0) {
      labels.tracks = labels.tracks.filter((t) => !unused.includes(t));
    }
    labels.reindex();

    ctx.pushUndoSnapshot(snapshot);
    if (instance && targets.some(([, i]) => i === instance)) {
      ctx.state.setInstance(null);
    }
    ctx.state.markChanged();
    toast.success(`Deleted ${targets.length} instance(s)`);
  },
};
