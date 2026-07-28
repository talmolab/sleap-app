/**
 * Navigation commands: frame-level and suggestion-level navigation.
 *
 * Ports SLEAP's GoNextLabeledFrame, GoPrevLabeledFrame,
 * GoNextSuggestedFrame, GoPrevSuggestedFrame, GoFrameGui.
 */

import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { isUserLabeledFrame } from "@/lib/frameLabeling";

/** Navigate to the next frame that has labels (any instance). */
export const GoNextLabeledFrame: Command = {
  name: "GoNextLabeledFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    // Get all labeled frame indices for the current video, sorted. Empty
    // LabeledFrames are kept (PyQt parity: GoNextLabeledFrame has no instance
    // filter — they are still labeled frames). Skipping over image-less frames
    // is the separate imaged-navigation mode's job.
    const frameIndices = labels.find({ video })
      .map((lf) => lf.frameIdx)
      .sort((a, b) => a - b);

    if (frameIndices.length === 0) return;

    // Find the first frame index strictly greater than current
    const next = frameIndices.find((idx) => idx > frameIdx);
    if (next !== undefined) {
      ctx.state.setFrameIdx(next);
    } else {
      // Wrap around to the first labeled frame
      ctx.state.setFrameIdx(frameIndices[0]);
    }
  },
};

/** Navigate to the previous frame that has labels. */
export const GoPrevLabeledFrame: Command = {
  name: "GoPrevLabeledFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    // All labeled frame indices for the current video, sorted (empties kept —
    // see GoNextLabeledFrame).
    const frameIndices = labels.find({ video })
      .map((lf) => lf.frameIdx)
      .sort((a, b) => a - b);

    if (frameIndices.length === 0) return;

    // Find the last frame index strictly less than current
    const prev = [...frameIndices].reverse().find((idx) => idx < frameIdx);
    if (prev !== undefined) {
      ctx.state.setFrameIdx(prev);
    } else {
      // Wrap around to the last labeled frame
      ctx.state.setFrameIdx(frameIndices[frameIndices.length - 1]);
    }
  },
};

/** Navigate to the next suggestion frame. */
/**
 * All suggestions in a stable GLOBAL order: video order (as in `labels.videos`)
 * then frame index. Suggestion navigation must span videos — SLEAP training
 * packages store one single-frame video per suggestion, so filtering to the
 * current video would strand the user on a one-frame video (Space appears
 * dead). For a single-video project this collapses to frame-index order.
 */
function orderedSuggestions(ctx: CommandContext) {
  const { labels } = ctx.state;
  if (!labels) return [];
  const vidIndex = new Map(labels.videos.map((v, i) => [v, i] as const));
  return [...labels.suggestions].sort((a, b) => {
    const va = vidIndex.get(a.video) ?? 0;
    const vb = vidIndex.get(b.video) ?? 0;
    return va !== vb ? va - vb : a.frameIdx - b.frameIdx;
  });
}

/** Navigate to a suggestion, switching video first when it lives elsewhere. */
function goToSuggestion(
  ctx: CommandContext,
  target: { video: CommandContext["state"]["video"]; frameIdx: number },
) {
  if (target.video && target.video !== ctx.state.video) {
    ctx.state.setVideo(target.video);
  }
  ctx.state.setFrameIdx(target.frameIdx);
}

/** Navigate to the next suggestion frame (across videos, wrapping). */
export const GoNextSuggestion: Command = {
  name: "GoNextSuggestion",
  topics: [UpdateTopic.Frame, UpdateTopic.Suggestions],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const sugg = orderedSuggestions(ctx);
    if (sugg.length === 0) return;

    const vidIndex = new Map(labels.videos.map((v, i) => [v, i] as const));
    const curV = vidIndex.get(video) ?? 0;
    const idx = sugg.findIndex((s) => s.video === video && s.frameIdx === frameIdx);

    const target =
      idx !== -1
        ? sugg[(idx + 1) % sugg.length]
        : sugg.find((s) => {
            const sv = vidIndex.get(s.video) ?? 0;
            return sv > curV || (sv === curV && s.frameIdx > frameIdx);
          }) ?? sugg[0];

    goToSuggestion(ctx, target);
  },
};

/** Navigate to the previous suggestion frame (across videos, wrapping). */
export const GoPrevSuggestion: Command = {
  name: "GoPrevSuggestion",
  topics: [UpdateTopic.Frame, UpdateTopic.Suggestions],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const sugg = orderedSuggestions(ctx);
    if (sugg.length === 0) return;

    const vidIndex = new Map(labels.videos.map((v, i) => [v, i] as const));
    const curV = vidIndex.get(video) ?? 0;
    const idx = sugg.findIndex((s) => s.video === video && s.frameIdx === frameIdx);

    const target =
      idx !== -1
        ? sugg[(idx - 1 + sugg.length) % sugg.length]
        : [...sugg].reverse().find((s) => {
            const sv = vidIndex.get(s.video) ?? 0;
            return sv < curV || (sv === curV && s.frameIdx < frameIdx);
          }) ?? sugg[sugg.length - 1];

    goToSuggestion(ctx, target);
  },
};

/** Navigate to the first frame (frame 0). */
export const GoToStartFrame: Command = {
  name: "GoToStartFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    ctx.state.setFrameIdx(0);
  },
};

/** Navigate to the last frame of the current video. */
export const GoToEndFrame: Command = {
  name: "GoToEndFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { video } = ctx.state;
    if (!video) return;
    const totalFrames = video.shape?.[0] ?? 0;
    if (totalFrames > 0) {
      ctx.state.setFrameIdx(totalFrames - 1);
    }
  },
};

/** Navigate to a specific frame number. */
export const GoToFrame: Command = {
  name: "GoToFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const frameIdx = params?.frameIdx;
    if (typeof frameIdx !== "number") return;
    ctx.state.setFrameIdx(frameIdx);
  },
};

/** Navigate to the last frame where the user interacted with an instance. */
export const GoToLastInteracted: Command = {
  name: "GoToLastInteracted",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { lastInteractedFrame } = ctx.state;
    if (lastInteractedFrame !== null) {
      ctx.state.setFrameIdx(lastInteractedFrame);
    }
  },
};

/** Navigate to the next frame with user-labeled (non-predicted) instances. */
export const GoNextUserFrame: Command = {
  name: "GoNextUserFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const userFrames = labels.find({ video })
      // "user-labeled" = any manual annotation (incl. a user centroid), not just
      // a non-predicted skeleton instance — mirrors io.js isUserLabeled.
      .filter((lf) => isUserLabeledFrame(lf))
      .map((lf) => lf.frameIdx)
      .sort((a, b) => a - b);

    if (userFrames.length === 0) return;

    const next = userFrames.find((idx) => idx > frameIdx);
    ctx.state.setFrameIdx(next !== undefined ? next : userFrames[0]);
  },
};

/**
 * Navigate to the next frame where a track first appears ("spawns").
 *
 * Finds the first frame index for each track in the current video,
 * then navigates to the next spawn frame after the current position.
 * Wraps around if at the end.
 */
/** Select a range from the current frame to a user-specified target frame. */
export const SelectToFrame: Command = {
  name: "SelectToFrame",
  topics: [],
  execute(ctx: CommandContext) {
    const { frameIdx, video } = ctx.state;
    if (!video) return;

    const input = window.prompt("Select to frame number:", String(frameIdx));
    if (input === null) return;

    const target = parseInt(input, 10);
    if (isNaN(target)) return;

    const maxFrame = video.shape ? (video.shape[0] ?? 1) - 1 : Infinity;
    const clamped = Math.max(0, Math.min(target, maxFrame));

    const rangeStart = Math.min(frameIdx, clamped);
    const rangeEnd = Math.max(frameIdx, clamped);

    ctx.state.set("frameRange", [rangeStart, rangeEnd] as [number, number]);
    ctx.state.set("hasFrameRange", true);
  },
};

export const GoNextTrackSpawnFrame: Command = {
  name: "GoNextTrackSpawnFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const tracks = labels.tracks;
    if (tracks.length === 0) return;

    // Get all labeled frames for this video
    const videoFrames = labels.find({ video });

    // For each track, find the first frame where it appears
    const spawnFrames = new Set<number>();
    for (const track of tracks) {
      let earliest = Infinity;
      for (const lf of videoFrames) {
        if (lf.instances.some((inst) => inst.track === track)) {
          if (lf.frameIdx < earliest) {
            earliest = lf.frameIdx;
          }
        }
      }
      if (earliest !== Infinity) {
        spawnFrames.add(earliest);
      }
    }

    if (spawnFrames.size === 0) return;

    const sorted = [...spawnFrames].sort((a, b) => a - b);

    // Find the next spawn frame after current
    const next = sorted.find((idx) => idx > frameIdx);
    ctx.state.setFrameIdx(next !== undefined ? next : sorted[0]);
  },
};
