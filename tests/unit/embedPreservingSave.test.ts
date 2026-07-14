/**
 * Tests for embed-preserving saves of pkg.slp projects (#213).
 *
 * `saveSlpToBytes` defaults `embed` to false, which silently drops the
 * embedded image datasets of a pkg.slp. `planEmbedPreservingSave` must pick an
 * embed mode and temporarily register previously-embedded frames that the mode
 * would miss (e.g. centroid-only frames outside the suggestion list) as
 * suggestions, so a save→load round trip keeps every embedded frame.
 */

import { describe, it, expect } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  SuggestionFrame,
  UserCentroid,
  Video,
  loadSlp,
  saveSlpToBytes,
} from "@talmolab/sleap-io.js";
import type { VideoBackend } from "@talmolab/sleap-io.js";
import { planEmbedPreservingSave } from "@/lib/embedPreservingSave";

/** Minimal fake PNG payload — the SLP writer stores blobs opaquely. */
const PNG_STUB = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

/** An embedded (pkg.slp-style) video backed by a stub blob-serving backend. */
function makeEmbeddedVideo(frameNumbers: number[]): Video {
  const backend = {
    frameNumbers,
    shape: [frameNumbers.length, 4, 4, 1],
    fps: 30,
    dataset: "video0/video",
    async getFrame(frameIdx: number) {
      return frameNumbers.includes(frameIdx) ? PNG_STUB.slice() : null;
    },
    close() {},
  };
  return new Video({
    filename: "test.pkg.slp",
    backend: backend as unknown as VideoBackend,
    embedded: true,
  });
}

/**
 * A project mirroring the active-learning bug report: an embedded video with
 * images at source frames 10/20/30 — 10 labeled with a user skeleton
 * instance, 20 labeled with ONLY a centroid (not a suggestion), 30 an
 * unlabeled suggestion.
 */
function makeEmbeddedProject() {
  const video = makeEmbeddedVideo([10, 20, 30]);
  const skeleton = new Skeleton({ nodes: ["A", "B"], edges: [["A", "B"]] });
  const labeledFrames = [
    new LabeledFrame({
      video,
      frameIdx: 10,
      instances: [
        new Instance({ points: { A: [1, 1], B: [2, 2] }, skeleton }),
      ],
    }),
    new LabeledFrame({
      video,
      frameIdx: 20,
      centroids: [new UserCentroid({ x: 1, y: 2 })],
    }),
  ];
  const labels = new Labels({
    labeledFrames,
    videos: [video],
    skeletons: [skeleton],
    suggestions: [new SuggestionFrame({ video, frameIdx: 30 })],
  });
  return { labels, video };
}

describe("planEmbedPreservingSave", () => {
  it("is a no-op for projects without embedded videos", async () => {
    const video = new Video({ filename: "movie.mp4", openBackend: false });
    const labels = new Labels({ labeledFrames: [], videos: [video] });
    const plan = await planEmbedPreservingSave(labels);
    expect(plan.embed).toBe(false);
    expect(plan.unreadable.length).toBe(0);
    expect(labels.suggestions.length).toBe(0);
  });

  it("adds only the embedded frames user+suggestions would miss", async () => {
    const { labels } = makeEmbeddedProject();
    const plan = await planEmbedPreservingSave(labels);
    expect(plan.embed).toBe("user+suggestions");
    expect(plan.unreadable.length).toBe(0);
    // Frame 10 (user instance) and 30 (already a suggestion) are covered;
    // only the centroid-only frame 20 needs a temporary suggestion.
    expect(labels.suggestions.map((s) => s.frameIdx).sort()).toEqual([20, 30]);

    plan.restore();
    expect(labels.suggestions.map((s) => s.frameIdx)).toEqual([30]);
    plan.restore(); // idempotent
    expect(labels.suggestions.map((s) => s.frameIdx)).toEqual([30]);
  });

  it("reports embedded videos without a readable backend", async () => {
    const video = new Video({
      filename: "broken.pkg.slp",
      backend: null,
      embedded: true,
    });
    const labels = new Labels({
      labeledFrames: [new LabeledFrame({ video, frameIdx: 5 })],
      videos: [video],
    });
    const plan = await planEmbedPreservingSave(labels);
    expect(plan.embed).toBe("user+suggestions");
    expect(plan.unreadable).toEqual([video]);
    expect(labels.suggestions.length).toBe(0);
  });
});

describe("embed-preserving save round trip", () => {
  it("keeps every embedded frame across save → load", async () => {
    const { labels } = makeEmbeddedProject();
    const plan = await planEmbedPreservingSave(labels);
    let bytes: Uint8Array;
    try {
      bytes = await saveSlpToBytes(labels, { embed: plan.embed || undefined });
    } finally {
      plan.restore();
    }
    // In-memory labels are back to their pre-save suggestion list.
    expect(labels.suggestions.map((s) => s.frameIdx)).toEqual([30]);

    const reloaded = await loadSlp(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { openVideos: true }
    );
    const video = reloaded.videos[0];
    expect(video.hasEmbeddedImages).toBe(true);
    expect(video.embeddedFrameIndices).toEqual([10, 20, 30]);
    // The temporary suggestion is persisted in the file — the documented
    // trade-off that keeps frame 20's image embedded.
    expect(reloaded.suggestions.map((s) => s.frameIdx).sort()).toEqual([
      20, 30,
    ]);
    // Labels round-trip too.
    expect(reloaded.labeledFrames.length).toBe(2);
    const centroidFrame = reloaded.labeledFrames.find((f) => f.frameIdx === 20);
    expect(centroidFrame?.centroids.length).toBe(1);
  });

  it("documents the bug: saving without embed drops the images", async () => {
    const { labels } = makeEmbeddedProject();
    const bytes = await saveSlpToBytes(labels); // pre-fix behavior
    const reloaded = await loadSlp(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { openVideos: false }
    );
    // No embedded image data survives — the videos_json entry no longer
    // resolves to an in-file dataset.
    expect(reloaded.videos[0].embeddedFrameIndices ?? null).toBeNull();
  });
});
