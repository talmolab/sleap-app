import { describe, it, expect } from "../bun-test";
import type { Labels, Video } from "@/types";
import {
  generateImageFeatureSuggestions,
  type ImageFeaturesParams,
  type ImageFeaturesDeps,
} from "@/lib/imageFeatures";
import type { WorkerFrameBuffer } from "@/lib/imageFeaturesWorkerCore";

/** A fake 10-frame video (shape drives sampleFrames' candidate range). */
function fakeVideo(name: string): Video {
  return { shape: [10, 4, 4, 3], filename: name } as unknown as Video;
}
const fakeLabels = (): Labels => ({ suggestions: [] }) as unknown as Labels;

const PARAMS: ImageFeaturesParams = {
  perVideo: 3, // stride over 10 frames -> [0, 3, 6]
  sampleMethod: "stride",
  scaleCap: 128,
  pcaComponents: 2,
  nClusters: 2,
  perCluster: 5,
  seed: 1,
};

function fakeBuffer(frameIdx: number): WorkerFrameBuffer {
  return { frameIdx, width: 2, height: 2, data: new Uint8ClampedArray(16) };
}

describe("generateImageFeatureSuggestions", () => {
  it("decodes each sampled frame and offsets cluster groups per video", async () => {
    const decodeCalls: Array<{ video: string; frameIdx: number }> = [];
    const deps: ImageFeaturesDeps = {
      decode: async (video, frameIdx) => {
        decodeCalls.push({ video: video.filename as string, frameIdx });
        return fakeBuffer(frameIdx);
      },
      // group = position within the video's buffer list, alternating 0/1.
      runJob: async (job) => ({
        picks: job.frames.map((f, i) => ({ frameIdx: f.frameIdx, group: i % 2 })),
      }),
    };

    const videos = [fakeVideo("v0.mp4"), fakeVideo("v1.mp4")];
    const out = await generateImageFeatureSuggestions(
      fakeLabels(),
      videos,
      PARAMS,
      deps
    );

    // 3 sampled frames per video -> 6 decodes total.
    expect(decodeCalls.length).toBe(6);
    expect(out.length).toBe(6);

    // video 0: groups from picks (0,1,0) with offset 0 -> "0","1","0"
    const v0 = out.filter((s) => s.video === videos[0]);
    expect(v0.map((s) => s.frameIdx)).toEqual([0, 3, 6]);
    expect(v0.map((s) => s.group)).toEqual(["0", "1", "0"]);

    // video 1: same picks with offset (videoIdx * nClusters = 2) -> "2","3","2"
    const v1 = out.filter((s) => s.video === videos[1]);
    expect(v1.map((s) => s.frameIdx)).toEqual([0, 3, 6]);
    expect(v1.map((s) => s.group)).toEqual(["2", "3", "2"]);
  });

  it("reports decoding progress for every sampled frame", async () => {
    const phases: Array<[string, number, number]> = [];
    const deps: ImageFeaturesDeps = {
      decode: async (_v, frameIdx) => fakeBuffer(frameIdx),
      runJob: async (job) => ({ picks: job.frames.map((f) => ({ frameIdx: f.frameIdx, group: 0 })) }),
      onProgress: (phase, done, total) => phases.push([phase, done, total]),
    };
    await generateImageFeatureSuggestions(fakeLabels(), [fakeVideo("v0.mp4")], PARAMS, deps);

    const decoding = phases.filter((p) => p[0] === "decoding");
    expect(decoding.length).toBe(3);
    expect(decoding[2]).toEqual(["decoding", 3, 3]); // last decode: 3/3
    expect(phases.some((p) => p[0] === "clustering")).toBe(true);
  });

  it("dedupes repeated (video, frameIdx) picks", async () => {
    const deps: ImageFeaturesDeps = {
      decode: async (_v, frameIdx) => fakeBuffer(frameIdx),
      // pick frame 0 twice
      runJob: async () => ({
        picks: [
          { frameIdx: 0, group: 0 },
          { frameIdx: 0, group: 1 },
          { frameIdx: 3, group: 0 },
        ],
      }),
    };
    const out = await generateImageFeatureSuggestions(
      fakeLabels(),
      [fakeVideo("v0.mp4")],
      PARAMS,
      deps
    );
    expect(out.map((s) => s.frameIdx)).toEqual([0, 3]);
  });

  it("aborts before decoding when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let decodes = 0;
    const deps: ImageFeaturesDeps = {
      decode: async (_v, frameIdx) => {
        decodes++;
        return fakeBuffer(frameIdx);
      },
      runJob: async (job) => ({ picks: job.frames.map((f) => ({ frameIdx: f.frameIdx, group: 0 })) }),
      signal: ac.signal,
    };
    await expect(
      generateImageFeatureSuggestions(fakeLabels(), [fakeVideo("v0.mp4")], PARAMS, deps)
    ).rejects.toThrow();
    expect(decodes).toBe(0);
  });
});
