/**
 * Tests for the replace-video data core (re-point + frame-trim).
 *
 * Pure, decode-free: all videos are backend-less (`openBackend: false`) with an
 * explicit `shape`, so nothing here ever touches a real file or decoder.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
  SuggestionFrame,
} from "@talmolab/sleap-io.js";
import { labeledFramesBeyond, applyVideoReplacement } from "@/lib/replaceVideo";

/** Build a backend-less Video with an explicit shape — no file, no decode. */
function makeVideo(
  filename: string,
  shape: [number, number, number, number],
): Video {
  const v = new Video({
    filename,
    backendMetadata: { shape },
    openBackend: false,
  });
  // Ensure `.shape` is populated even if backendMetadata wiring changes.
  v.shape = shape;
  return v;
}

/**
 * Create a real (decode-free) project.
 *
 * - One skeleton with `numNodes` nodes.
 * - `video` ("old.mp4", 200 frames) holding labeled frames at the given indices.
 * - Each labeled frame gets one empty instance with set points.
 * - Optionally a suggestion referencing `video`.
 */
function makeProject(opts?: {
  frameIndices?: number[];
  oldShape?: [number, number, number, number];
  withSuggestion?: boolean;
  numNodes?: number;
}) {
  const frameIndices = opts?.frameIndices ?? [0, 50, 100];
  const oldShape = opts?.oldShape ?? [200, 480, 640, 3];
  const numNodes = opts?.numNodes ?? 2;

  const skeleton = new Skeleton({
    nodes: Array.from({ length: numNodes }, (_, i) => `node_${i}`),
    name: "test",
  });
  if (numNodes >= 2) skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);

  const video = makeVideo("old.mp4", oldShape);

  const labeledFrames: LabeledFrame[] = frameIndices.map((idx) => {
    const lf = new LabeledFrame({ video, frameIdx: idx });
    const inst = Instance.empty({ skeleton });
    for (let n = 0; n < numNodes; n++) {
      inst.points[n].xy = [10 * n + idx, 20 * n];
      inst.points[n].visible = true;
      inst.points[n].complete = true;
    }
    lf.instances.push(inst);
    return lf;
  });

  const suggestions: SuggestionFrame[] = opts?.withSuggestion
    ? [new SuggestionFrame({ video, frameIdx: frameIndices[0] })]
    : [];

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames,
    suggestions,
  });
  labels.reindex();

  return { labels, skeleton, video, labeledFrames };
}

describe("labeledFramesBeyond", () => {
  it("returns only the given video's frames at or beyond frameCount", () => {
    const { labels, video } = makeProject({ frameIndices: [0, 50, 100, 150] });

    const beyond = labeledFramesBeyond(labels, video, 100);
    const idxs = beyond.map((lf) => lf.frameIdx).sort((a, b) => a - b);
    // 100 and 150 are >= 100; 0 and 50 are in-range.
    expect(idxs).toEqual([100, 150]);
    expect(beyond.every((lf) => lf.video === video)).toBe(true);
  });

  it("excludes in-range frames and frames belonging to other videos", () => {
    const { labels, video } = makeProject({ frameIndices: [0, 50, 100] });

    // Add a frame for a different video at a high index — must be excluded.
    const other = makeVideo("other.mp4", [200, 480, 640, 3]);
    labels.videos.push(other);
    labels.labeledFrames.push(new LabeledFrame({ video: other, frameIdx: 199 }));
    labels.reindex();

    const beyond = labeledFramesBeyond(labels, video, 60);
    expect(beyond.map((lf) => lf.frameIdx)).toEqual([100]);
    expect(beyond.every((lf) => lf.video === video)).toBe(true);
  });

  it("returns [] when frameCount is NaN or undefined", () => {
    const { labels, video } = makeProject({ frameIndices: [0, 50, 100] });

    expect(labeledFramesBeyond(labels, video, NaN)).toEqual([]);
    expect(
      labeledFramesBeyond(labels, video, undefined as unknown as number),
    ).toEqual([]);
    expect(
      labeledFramesBeyond(labels, video, Infinity),
    ).toEqual([]);
  });
});

describe("applyVideoReplacement", () => {
  it("re-points all frames and trims nothing for a same-or-longer video", () => {
    const { labels, video } = makeProject({
      frameIndices: [0, 50, 100],
      withSuggestion: true,
    });
    const oldFrames = [...labels.labeledFrames];

    // Same length (200) — nothing should be trimmed.
    const newVideo = makeVideo("new.mp4", [200, 480, 640, 3]);
    const { trimmed } = applyVideoReplacement(labels, video, newVideo);

    expect(trimmed).toBe(0);
    expect(labels.labeledFrames.length).toBe(oldFrames.length);
    // Every (kept) frame now points at the new video.
    expect(labels.labeledFrames.every((lf) => lf.video === newVideo)).toBe(true);
    // videos swapped: new in, old out.
    expect(labels.videos).toContain(newVideo);
    expect(labels.videos).not.toContain(video);
    // Suggestion re-pointed to the new video.
    expect(labels.suggestions.length).toBe(1);
    expect(labels.suggestions[0].video).toBe(newVideo);
  });

  it("trims orphan frames beyond a shorter video and re-points the rest", () => {
    const { labels, video } = makeProject({ frameIndices: [0, 50, 100] });
    const orphan = labels.labeledFrames.find((lf) => lf.frameIdx === 100)!;

    // Shorter video: only 60 frames, so frameIdx 100 is orphaned.
    const newVideo = makeVideo("short.mp4", [60, 480, 640, 3]);
    const { trimmed } = applyVideoReplacement(labels, video, newVideo);

    expect(trimmed).toBe(1);
    // The orphan frame is gone; 0 and 50 remain.
    expect(labels.labeledFrames.length).toBe(2);
    expect(labels.labeledFrames).not.toContain(orphan);
    const keptIdxs = labels.labeledFrames
      .map((lf) => lf.frameIdx)
      .sort((a, b) => a - b);
    expect(keptIdxs).toEqual([0, 50]);
    // Kept frames re-pointed to the new video.
    expect(labels.labeledFrames.every((lf) => lf.video === newVideo)).toBe(true);

    // reindex() consistency: find() resolves the kept frame on the new video.
    const found = labels.find({ video: newVideo, frameIdx: 50 });
    expect(found.length).toBe(1);
    expect(found[0].frameIdx).toBe(50);
    expect(found[0].video).toBe(newVideo);
  });

  it("treats a new video without a usable shape as unbounded (no trim)", () => {
    const { labels, video } = makeProject({ frameIndices: [0, 50, 100] });

    // No shape => newCount = Infinity => nothing trimmed.
    const newVideo = new Video({ filename: "noshape.mp4", openBackend: false });
    const { trimmed } = applyVideoReplacement(labels, video, newVideo);

    expect(trimmed).toBe(0);
    expect(labels.labeledFrames.length).toBe(3);
    expect(labels.labeledFrames.every((lf) => lf.video === newVideo)).toBe(true);
  });
});
