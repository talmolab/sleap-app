/**
 * Navigation commands: frame-level and suggestion-level navigation.
 *
 * Ports SLEAP's GoNextLabeledFrame, GoPrevLabeledFrame,
 * GoNextSuggestedFrame, GoPrevSuggestedFrame, GoFrameGui.
 */

import { UpdateTopic } from "../types";
import type { Video } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { isUserLabeledFrame } from "@/lib/frameLabeling";
import { promptDialog } from "@/stores/promptStore";

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

/**
 * Orders (video, frameIdx) positions by video position (per ctx.state.videos
 * -- the same order the Videos/Frames panels use), then frame index. Lets
 * GoNext/PrevSuggestion compare an arbitrary suggestion against the current
 * position without collapsing both into one combined scalar.
 */
function suggestionOrder(videos: Video[]) {
  const videoOrder = new Map(videos.map((v, i) => [v, i]));
  return (aVideo: Video, aFrame: number, bVideo: Video, bFrame: number) => {
    const va = videoOrder.get(aVideo) ?? 0;
    const vb = videoOrder.get(bVideo) ?? 0;
    return va !== vb ? va - vb : aFrame - bFrame;
  };
}

/** Navigate to the next suggestion frame. */
export const GoNextSuggestion: Command = {
  name: "GoNextSuggestion",
  topics: [UpdateTopic.Frame, UpdateTopic.Suggestions],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;
    if (labels.suggestions.length === 0) return;

    // Ordered across ALL videos, not just the current one -- so once the
    // current video's suggestions run out, Next carries the user into the
    // next video's instead of getting stuck (#326). Suggestions commonly
    // span every video now that #324 changed the generation default.
    const compare = suggestionOrder(labels.videos);
    const sorted = [...labels.suggestions].sort((a, b) =>
      compare(a.video, a.frameIdx, b.video, b.frameIdx)
    );

    const next = sorted.find(
      (s) => compare(s.video, s.frameIdx, video, frameIdx) > 0
    );
    const target = next ?? sorted[0]; // wrap around
    if (target.video !== video) ctx.state.setVideo(target.video);
    ctx.state.setFrameIdx(target.frameIdx);
  },
};

/** Navigate to the previous suggestion frame. */
export const GoPrevSuggestion: Command = {
  name: "GoPrevSuggestion",
  topics: [UpdateTopic.Frame, UpdateTopic.Suggestions],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;
    if (labels.suggestions.length === 0) return;

    // See GoNextSuggestion above -- same cross-video ordering (#326).
    const compare = suggestionOrder(labels.videos);
    const sorted = [...labels.suggestions].sort((a, b) =>
      compare(a.video, a.frameIdx, b.video, b.frameIdx)
    );

    const prev = [...sorted]
      .reverse()
      .find((s) => compare(s.video, s.frameIdx, video, frameIdx) < 0);
    const target = prev ?? sorted[sorted.length - 1]; // wrap around
    if (target.video !== video) ctx.state.setVideo(target.video);
    ctx.state.setFrameIdx(target.frameIdx);
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

/** Navigate to the previous frame with user-labeled (non-predicted) instances. */
export const GoPrevUserFrame: Command = {
  name: "GoPrevUserFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const { labels, video, frameIdx } = ctx.state;
    if (!labels || !video) return;

    const userFrames = labels
      .find({ video })
      .filter((lf) => isUserLabeledFrame(lf))
      .map((lf) => lf.frameIdx)
      .sort((a, b) => a - b);

    if (userFrames.length === 0) return;

    // Last user frame strictly before the current one; wrap to the last.
    let prev: number | undefined;
    for (let i = userFrames.length - 1; i >= 0; i--) {
      if (userFrames[i] < frameIdx) {
        prev = userFrames[i];
        break;
      }
    }
    ctx.state.setFrameIdx(prev !== undefined ? prev : userFrames[userFrames.length - 1]);
  },
};

/** Jump to the user-bookmarked frame (set via Mark Frame / ⌘M). */
export const GoToMarkedFrame: Command = {
  name: "GoToMarkedFrame",
  topics: [UpdateTopic.Frame],
  execute(ctx: CommandContext) {
    const marked = ctx.state.markedFrame;
    if (!marked) return;
    if (marked.video !== ctx.state.video) ctx.state.setVideo(marked.video);
    ctx.state.setFrameIdx(marked.frameIdx);
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
  async execute(ctx: CommandContext) {
    const { frameIdx, video } = ctx.state;
    if (!video) return;

    const input = await promptDialog({
      title: "Select to frame",
      message: "Select to frame number:",
      defaultValue: String(frameIdx),
    });
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
