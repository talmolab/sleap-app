/**
 * Track commands: track creation, assignment, and transposition.
 *
 * Ports SLEAP's AddTrack, SetSelectedInstanceTrack, TransposeInstances.
 */

import { Track } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";

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
 * Params:
 *   trackIdx: number - index into labels.tracks
 */
export const SetInstanceTrack: Command = {
  name: "SetInstanceTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, instance } = ctx.state;
    if (!labels || !instance) return;

    const trackIdx = params?.trackIdx;
    if (typeof trackIdx !== "number") return;

    if (trackIdx < 0 || trackIdx >= labels.tracks.length) return;

    instance.track = labels.tracks[trackIdx];

    ctx.state.markChanged();
  },
};

/**
 * Swap tracks between two instances on the current frame.
 * The selected instance swaps with the next instance that has a different track.
 */
export const TransposeInstances: Command = {
  name: "TransposeInstances",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx, instance } = ctx.state;
    if (!labels || !video || !instance) return;

    const frames = labels.find({ video, frameIdx });
    if (frames.length === 0) return;

    const lf = frames[0];
    const instances = lf.instances;

    // Find the selected instance's index
    const selectedIdx = instances.indexOf(instance);
    if (selectedIdx === -1) return;

    // Find the next instance with a different track to swap with
    // Wrap around if needed
    let otherIdx = -1;
    for (let i = 1; i < instances.length; i++) {
      const candidate = instances[(selectedIdx + i) % instances.length];
      if (candidate.track !== instance.track) {
        otherIdx = (selectedIdx + i) % instances.length;
        break;
      }
    }

    if (otherIdx === -1) return;

    // Swap tracks
    const tempTrack = instance.track;
    instance.track = instances[otherIdx].track;
    instances[otherIdx].track = tempTrack;

    ctx.state.markChanged();
  },
};

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

/** Paste the clipboard track onto the selected instance. */
export const PasteTrack: Command = {
  name: "PasteTrack",
  topics: [UpdateTopic.Tracks, UpdateTopic.Instance],
  execute(ctx: CommandContext) {
    const { instance, clipboardTrack } = ctx.state;
    if (!instance || !clipboardTrack) return;
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

    // Take a multi-frame snapshot before modifying
    const snapshot = ctx.takeAllFramesSnapshot("PropagateTrackLabels");
    ctx.pushUndoSnapshot(snapshot);

    // Get all labeled frames for this video, sorted by frame index
    const videoFrames = labels
      .find({ video })
      .sort((a, b) => a.frameIdx - b.frameIdx);

    // Start from frames after the current one
    for (const lf of videoFrames) {
      if (lf.frameIdx <= frameIdx) continue;

      // Check if oldTrack appears in this frame
      const matchingInstances = lf.instances.filter(
        (inst) => inst.track === oldTrack
      );

      if (matchingInstances.length === 0) {
        // oldTrack not found — stop propagation
        break;
      }

      // Also swap newTrack -> oldTrack if present (bidirectional swap)
      const reverseInstances = lf.instances.filter(
        (inst) => inst.track === newTrack
      );

      for (const inst of matchingInstances) {
        inst.track = newTrack;
      }
      for (const inst of reverseInstances) {
        inst.track = oldTrack;
      }
    }

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
