/**
 * "Random sample" frame indices for local inference. "Random sample (all
 * videos)" runs one `random_video` inference per video with `videoIndex` set
 * to that video; each run used to draw its frames from the ACTIVE video's
 * length, so a shorter video got out-of-range indices (sleap-nn skips them)
 * and a longer one was only ever sampled from its first frames.
 * `runInference` runs with Tauri faked; the argv it spawns is checked.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "../bun-test";
import type { InferenceConfig } from "@/stores/inferenceStore";

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => true);
vi.mock("@/platform", () => ({ isTauri: true, getPlatform: async () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "/tmp",
  join: async (...parts: string[]) => parts.join("/"),
  dirname: async (p: string) => p.replace(/\/[^/]+$/, ""),
  basename: async (p: string) => p.replace(/^.*\//, ""),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: async () => {},
  writeFile: async () => {},
}));

let runInference: typeof import("@/platform/backend").runInference;
let randomSampleFrameCount: typeof import("@/platform/inferenceArgs").randomSampleFrameCount;
let useAppStore: typeof import("@/stores/appStore").useAppStore;

beforeAll(async () => {
  ({ runInference } = await import("@/platform/backend"));
  ({ randomSampleFrameCount } = await import("@/platform/inferenceArgs"));
  ({ useAppStore } = await import("@/stores/appStore"));
});

const video = (frames: number | null) => ({
  filename: "/data/project.pkg.slp",
  hasEmbeddedImages: true,
  shape: frames === null ? null : [frames, 64, 64, 1],
});
const shortVideo = video(30);
const longVideo = video(5000);

function setProject(videos: ReturnType<typeof video>[], active: ReturnType<typeof video>) {
  useAppStore.setState({
    labels: { videos } as unknown as ReturnType<typeof useAppStore.getState>["labels"],
    video: active as unknown as ReturnType<typeof useAppStore.getState>["video"],
  });
}

const config = (overrides: Partial<InferenceConfig>) =>
  ({
    modelPaths: ["/models/run"],
    videoIndex: 0,
    frameRange: "random_video",
    sampleCount: 20,
    batchSize: 4,
    device: "auto",
    ...overrides,
  }) as InferenceConfig;

/** The `--frames` value of the sleap-nn argv runInference spawned. */
function spawnedFrames(): number[] {
  const args = (invokeMock.mock.calls.at(-1)![1] as unknown as { args: string[] }).args;
  return args[args.indexOf("--frames") + 1].split(",").map(Number);
}

describe("random-sample inference draws from the target video's own frames", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("samples a short video within its own length while a longer video is active", async () => {
    setProject([shortVideo, longVideo], longVideo);
    await runInference(config({ videoIndex: 0, sampleCount: 20 }), "/data/project.pkg.slp", () => {});
    const frames = spawnedFrames();
    expect(frames).toHaveLength(20);
    expect(Math.max(...frames)).toBeLessThan(30);
  });

  it("samples a long video across its whole length while a shorter video is active", async () => {
    setProject([shortVideo, longVideo], shortVideo);
    const seen: number[] = [];
    for (let run = 0; run < 5; run++) {
      await runInference(config({ videoIndex: 1, sampleCount: 20 }), "/data/project.pkg.slp", () => {});
      seen.push(...spawnedFrames());
    }
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...seen)).toBeLessThan(5000);
  });

  it("refuses to sample a video whose frame count is unknown instead of using another video's", async () => {
    setProject([video(null), longVideo], longVideo);
    await expect(
      runInference(config({ videoIndex: 0 }), "/data/project.pkg.slp", () => {}),
    ).rejects.toThrow("video 1 has an unknown frame count");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("randomSampleFrameCount", () => {
  it("uses the indexed video, falling back to the active one only for 'all'", () => {
    const videos = [shortVideo, longVideo];
    expect(randomSampleFrameCount(0, videos, longVideo)).toBe(30);
    expect(randomSampleFrameCount(1, videos, shortVideo)).toBe(5000);
    expect(randomSampleFrameCount("all", videos, shortVideo)).toBe(30);
    expect(randomSampleFrameCount(2, videos, longVideo)).toBe(0);
    expect(randomSampleFrameCount(0, [video(null)], longVideo)).toBe(0);
  });
});
