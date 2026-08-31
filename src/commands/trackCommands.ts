/**
 * Track commands: track creation, assignment, and transposition.
 *
 * Ports SLEAP's AddTrack, SetSelectedInstanceTrack, TransposeInstances.
 */

import type { Instance, LabeledFrame } from "@talmolab/sleap-io.js";
import { Track } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { useAppStore } from "../stores/appStore";

/**
 * Swap `oldTrack`<->`newTrack` across `frames` (assumed already sorted by
 * frameIdx and scoped to one video), stopping at the first frame that no
 * longer contains `oldTrack`. Shared by {@link TransposeInstances} (when the
 * "Propagate Track Labels" preference is on) and the standalone
 * {@link PropagateTrackLabels} command — both take their own scoped
 * snapshot before calling this, so it only ever mutates in-memory state.
 */
function applyTrackSwapForward(
  frames: LabeledFrame[],
  oldTrack: Track,
  newTrack: Track,
): void {
  for (const lf of frames) {
    const matchingInstances = lf.instances.filter((inst) => inst.track === oldTrack);
    if (matchingInstances.length === 0) break; // oldTrack not found — stop propagation

    // Also swap newTrack -> oldTrack if present (bidirectional swap)
    const reverseInstances = lf.instances.filter((inst) => inst.track === newTrack);
    for (const inst of matchingInstances) inst.track = newTrack;
    for (const inst of reverseInstances) inst.track = oldTrack;
  }
}

/** Create a new Track and assign it to the selected instance. */
export const AddTrack: Command = {
  name: "AddTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, instance } = ctx.state;
    if (!labels || !instance) return;

    // Determine next track number
    const trackNumber = labels.tracks.length + 1;
    const track = new Track(`Track ${trackNumber}`);

    labels.tracks.push(track);
    instance.track = track;

    ctx.state.markChanged();
  },
};

/**
 * Assign an existing track to the selected instance.
 *
 * If the instance already had a track and "Propagate Track Labels" is on,
 * this swaps forward instead of just reassigning the current frame — same
 * propagation semantics as {@link TransposeInstances}. Otherwise, on just
 * the current frame: enforces mutual exclusivity (any OTHER instance here
 * already on the target track gets unassigned — a track identifies one
 * animal per frame) and keeps a linked predicted instance's track in sync.
 * Matches legacy SLEAP's `SetSelectedInstanceTrack` (`sleap/gui/commands.py`).
 *
 * Params:
 *   trackIdx: number - index into labels.tracks
 */
export const SetInstanceTrack: Command = {
  name: "SetInstanceTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance, video, frameIdx, labeledFrame } = ctx.state;
    if (!labels || !instance) return;

    const trackIdx = params?.trackIdx;
    if (typeof trackIdx !== "number") return;
    if (trackIdx < 0 || trackIdx >= labels.tracks.length) return;
    const newTrack = labels.tracks[trackIdx];
    if (instance.track === newTrack) return;

    const oldTrack = instance.track;

    if (oldTrack && video && ctx.state.propagateTrackLabels) {
      const maxFrameIdx = ctx.state.frameRange ? ctx.state.frameRange[1] : undefined;
      const { snapshot, frames: videoFrames } = ctx.takeVideoFramesSnapshotFrom(
        "SetInstanceTrack",
        video,
        frameIdx - 1,
        maxFrameIdx,
      );
      ctx.pushUndoSnapshot(snapshot);
      applyTrackSwapForward(videoFrames, oldTrack, newTrack);
    } else {
      // Single-frame assignment. `skipAutoSnapshot` is set so the propagate
      // branch above can manage its own scoped snapshot; take the
      // equivalent single-frame one here to keep this path undoable too.
      ctx.pushUndoSnapshot(ctx.takeSnapshot("SetInstanceTrack"));

      if (labeledFrame) {
        for (const inst of labeledFrame.instances) {
          if (inst !== instance && inst.track === newTrack) {
            inst.track = null;
          }
        }
      }
      instance.track = newTrack;
      if (instance.fromPredicted) {
        instance.fromPredicted.track = newTrack;
      }
    }

    ctx.state.markChanged();
  },
};

/**
 * Swap tracks between exactly two instances on the current frame — either
 * the frame's only two instances (auto-paired, no ambiguity) or an explicit
 * pair supplied via `params.instances` (from the multi-instance picker, see
 * {@link requestTranspose} — needed when the frame has 3+ instances and
 * there's no way to guess which two the user means).
 *
 * When the "Propagate Track Labels" preference (`ctx.state.propagateTrackLabels`)
 * is on and both swapped instances had tracks, the swap also propagates
 * forward: to the end of the video, or to the active seekbar frame range if
 * one is selected — matching legacy SLEAP's `TransposeInstances`/
 * `SetSelectedInstanceTrack` (`sleap/gui/commands.py`), which bake
 * propagation into the same action rather than requiring a separate step.
 *
 * Manages its own undo snapshot (`skipAutoSnapshot`) scoped to exactly the
 * frames that can change — this video, from the current frame through the
 * propagation's end point — so a propagating transpose is still a single
 * undo step, and never pays for cloning the rest of the project (#328).
 */
export const TransposeInstances: Command = {
  name: "TransposeInstances",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    let first: Instance;
    let second: Instance;
    const providedPair = params?.instances as [Instance, Instance] | undefined;
    if (providedPair) {
      [first, second] = providedPair;
    } else {
      const frames = labels.find({ video, frameIdx });
      if (frames.length === 0) return;
      const instances = frames[0].instances;
      // Exactly two instances can be auto-paired, matching legacy's
      // behavior. Three or more requires the click-select flow (see
      // requestTranspose), which always supplies `params.instances`.
      if (instances.length !== 2) return;
      [first, second] = instances;
    }
    if (first === second) return;

    const oldTrack = first.track;
    const newTrack = second.track;
    const propagate = ctx.state.propagateTrackLabels && !!oldTrack && !!newTrack;
    const maxFrameIdx = propagate
      ? (ctx.state.frameRange ? ctx.state.frameRange[1] : undefined)
      : frameIdx;

    // Scoped snapshot covering the current frame (always) through the
    // propagation's end point (only when propagating) — one undo entry for
    // the whole operation. `frameIdx - 1` as the exclusive lower bound
    // includes the current frame itself.
    const { snapshot, frames: videoFrames } = ctx.takeVideoFramesSnapshotFrom(
      "TransposeInstances",
      video,
      frameIdx - 1,
      maxFrameIdx,
    );
    ctx.pushUndoSnapshot(snapshot);

    const tempTrack = first.track;
    first.track = second.track;
    second.track = tempTrack;

    if (propagate) {
      applyTrackSwapForward(
        videoFrames.filter((lf) => lf.frameIdx > frameIdx),
        oldTrack,
        newTrack,
      );
    }

    ctx.state.markChanged();
  },
};

/**
 * Entry point for the Transpose shortcut/menu item. Transposes the current
 * frame's instances directly when there are exactly 2 (matching legacy's
 * auto-pair behavior — no prompt needed), or starts the click-select
 * picker (`instanceSequencePick`, resolved by `TransposePickBar`) when
 * there are 3+, since there's no reliable way to guess which pair the user
 * means. Mirrors legacy's `TransposeInstances.ask_and_do`
 * (`sleap/gui/commands.py`).
 */
export function requestTranspose(ctx: CommandContext): void {
  const { labels, video, frameIdx } = ctx.state;
  if (!labels || !video) return;
  const frames = labels.find({ video, frameIdx });
  if (frames.length === 0) return;
  const count = frames[0].instances.length;
  if (count < 2) return;
  if (count === 2) {
    ctx.execute(TransposeInstances);
    return;
  }
  useAppStore.getState().startInstanceSequencePick(2);
}

/** Copy the selected instance's track to the clipboard. */
export const CopyTrack: Command = {
  name: "CopyTrack",
  topics: [],
  execute(ctx: CommandContext) {
    const { instance } = ctx.state;
    if (!instance?.track) return;
    ctx.setState({ clipboardTrack: instance.track });
  },
};

/**
 * Paste the clipboard track onto the selected instance.
 *
 * Enforces mutual exclusivity of tracks within a frame first — a track
 * identifies one animal per frame, so any OTHER instance on the current
 * frame that already has this track gets unassigned. Matches legacy
 * SLEAP's `PasteInstanceTrack` (`sleap/gui/commands.py`); without this, two
 * instances on one frame could silently end up sharing a track, corrupting
 * downstream track-based analysis/export.
 */
export const PasteTrack: Command = {
  name: "PasteTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { instance, clipboardTrack, labeledFrame } = ctx.state;
    if (!instance || !clipboardTrack) return;

    if (labeledFrame) {
      for (const inst of labeledFrame.instances) {
        if (inst !== instance && inst.track === clipboardTrack) {
          inst.track = null;
        }
      }
    }

    instance.track = clipboardTrack;
    ctx.state.markChanged();
  },
};

/**
 * Delete the selected instance AND remove its track from labels.tracks.
 * Also removes the track from any other instances across all labeled frames.
 */
export const DeleteInstanceAndTrack: Command = {
  name: "DeleteInstanceAndTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, instance } = ctx.state;
    if (!labels || !video || !instance) return;

    const track = instance.track;

    // Remove the track from all instances across all labeled frames
    if (track) {
      for (const lf of labels.labeledFrames) {
        for (const inst of lf.instances) {
          if (inst.track === track) {
            inst.track = undefined;
          }
        }
      }
      // Remove track from labels.tracks
      const trackIdx = labels.tracks.indexOf(track);
      if (trackIdx >= 0) {
        labels.tracks.splice(trackIdx, 1);
      }
    }

    // Delete the selected instance from the current frame
    const frames = labels.find({ video, frameIdx });
    if (frames.length > 0) {
      const lf = frames[0];
      const instIdx = lf.instances.indexOf(instance);
      if (instIdx >= 0) {
        lf.instances.splice(instIdx, 1);
      }
    }

    // Clear selection
    ctx.state.setInstance(null);
    ctx.state.markChanged();
  },
};

/**
 * Remove a track from labels.tracks and unassign it from all instances.
 * Does NOT delete any instances.
 *
 * Params:
 *   track?: Track - the track object to remove
 *   trackIdx?: number - index into labels.tracks (used if track not provided)
 */
export const DeleteTrack: Command = {
  name: "DeleteTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels } = ctx.state;
    if (!labels) return;

    let track: Track | undefined;
    if (params?.track instanceof Track) {
      track = params.track;
    } else if (typeof params?.trackIdx === "number") {
      const idx = params.trackIdx;
      if (idx >= 0 && idx < labels.tracks.length) {
        track = labels.tracks[idx];
      }
    }
    if (!track) return;

    // Remove track from all instances across all labeled frames
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) {
        if (inst.track === track) {
          inst.track = undefined;
        }
      }
    }

    // Remove track from labels.tracks
    const trackIdx = labels.tracks.indexOf(track);
    if (trackIdx >= 0) {
      labels.tracks.splice(trackIdx, 1);
    }

    ctx.state.markChanged();
  },
};

/**
 * Find and remove tracks not assigned to any instance across all labeled frames.
 */
export const DeleteUnusedTracks: Command = {
  name: "DeleteUnusedTracks",
  topics: [UpdateTopic.Tracks],
  execute(ctx: CommandContext) {
    const { labels } = ctx.state;
    if (!labels) return;

    // Collect all tracks that are in use
    const usedTracks = new Set<Track>();
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) {
        if (inst.track) {
          usedTracks.add(inst.track);
        }
      }
    }

    // Remove unused tracks
    const before = labels.tracks.length;
    labels.tracks = labels.tracks.filter((t) => usedTracks.has(t));

    if (labels.tracks.length < before) {
      ctx.state.markChanged();
    }
  },
};

/**
 * Clear all tracks from labels.tracks and unassign tracks from all instances.
 */
export const DeleteAllTracks: Command = {
  name: "DeleteAllTracks",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels } = ctx.state;
    if (!labels) return;

    // Unassign tracks from all instances
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) {
        if (inst.track) {
          inst.track = undefined;
        }
      }
    }

    // Clear all tracks
    labels.tracks = [];

    ctx.state.markChanged();
  },
};

/**
 * Propagate track labels forward from the current frame.
 *
 * Starting from the current frame, iterates forward through labeled frames
 * in the same video. For each frame, swaps instances from oldTrack to newTrack.
 * Stops when reaching a frame where oldTrack doesn't appear.
 *
 * This enables "fix once, propagate forward" during proofreading.
 *
 * Params:
 *   oldTrack: Track - the track to replace
 *   newTrack: Track - the track to assign
 */
export const PropagateTrackLabels: Command = {
  name: "PropagateTrackLabels",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const oldTrack = params?.oldTrack as Track | undefined;
    const newTrack = params?.newTrack as Track | undefined;
    if (!oldTrack || !newTrack) return;

    // Scoped snapshot: propagation only ever reassigns `.track` on existing
    // instances in THIS video, strictly after the current frame — it never
    // creates/deletes frames or touches other videos — so there's no need to
    // clone the whole project's frames the way takeAllFramesSnapshot does.
    // This same traversal also gathers the sorted, already-filtered frame
    // list the loop below needs, replacing the separate find({video}) call
    // (which, with no frameIdx, falls into sleap-io.js's full-project linear
    // scan) with a single pass.
    const { snapshot, frames: videoFrames } = ctx.takeVideoFramesSnapshotFrom(
      "PropagateTrackLabels",
      video,
      frameIdx,
    );
    ctx.pushUndoSnapshot(snapshot);

    applyTrackSwapForward(videoFrames, oldTrack, newTrack);

    ctx.state.markChanged();
  },
};

/**
 * Rename a track. Because every instance references the same Track object, the
 * new name propagates to all instances/frames at once. Undoable — the snapshot
 * captures track names by value.
 */
export const SetTrackName: Command = {
  name: "SetTrackName",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const track = params?.track as Track | undefined;
    const name = params?.name as string | undefined;
    if (!track || name === undefined) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === track.name) return;
    track.name = trimmed;
    ctx.state.markChanged();
  },
};
