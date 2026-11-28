import { describe, expect, test } from "bun:test";
import {
  Instance,
  LabeledFrame,
  Labels,
  PreviewFrame,
  Skeleton,
  Video,
  saveSlpToBytes,
  type VideoBackend,
} from "@talmolab/sleap-io.js";
import { loadSlpPreview } from "@talmolab/sleap-io.js/lite";
import { ensureProjectPreviewFrame } from "@/lib/previewCapture";

function makeMockBackend(width = 160, height = 120): {
  backend: VideoBackend;
  getCalls: () => number[];
} {
  const calls: number[] = [];
  const backend: VideoBackend = {
    filename: "video.mp4",
    shape: [10, height, width, 3],
    async getFrame(frameIndex: number) {
      calls.push(frameIndex);
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = (i + frameIndex * 13) & 255;
        rgba[i * 4 + 1] = 100;
        rgba[i * 4 + 2] = 180;
        rgba[i * 4 + 3] = 255;
      }
      return { data: rgba, width, height } as ImageData;
    },
    close() {},
  };
  return { backend, getCalls: () => calls };
}

describe("ensureProjectPreviewFrame", () => {
  test("captures current labeled frame and caches it across repeated saves", async () => {
    const skel = new Skeleton({ nodes: ["head", "tail"] });
    const { backend, getCalls } = makeMockBackend(200, 150);
    const video = new Video({ filename: "video.mp4", backend, openBackend: false });
    const lf2 = new LabeledFrame({
      video,
      frameIdx: 2,
      instances: [Instance.fromArray([[10, 20], [30, 40]], skel)],
    });
    const lf5 = new LabeledFrame({
      video,
      frameIdx: 5,
      instances: [Instance.fromArray([[50, 60], [70, 80]], skel)],
    });
    const labels = new Labels({
      labeledFrames: [lf2, lf5],
      videos: [video],
      skeletons: [skel],
    });

    await ensureProjectPreviewFrame(labels, {
      currentVideo: video,
      currentFrameIdx: 5,
    });

    expect(getCalls()).toEqual([5]);
    expect(labels.previewFrames).toHaveLength(1);
    expect(labels.previewFrames[0].frameIdx).toBe(5);
    expect(labels.previewFrames[0].origWidth).toBe(200);
    expect(labels.previewFrames[0].origHeight).toBe(150);

    // Second call is a no-op (cached on labels.previewFrames).
    await ensureProjectPreviewFrame(labels, {
      currentVideo: video,
      currentFrameIdx: 2,
    });
    expect(getCalls()).toEqual([5]);

    // Saved SLP carries the captured /preview.
    const bytes = await saveSlpToBytes(labels);
    const previews = await loadSlpPreview(bytes);
    expect(previews).toHaveLength(1);
    expect(previews[0].frameIdx).toBe(5);
    expect(previews[0].data[0]).toBe(0xff);
    expect(previews[0].data[1]).toBe(0xd8);
  });

  test("skips embedded .pkg.slp projects and preserves existing previews", async () => {
    const { backend, getCalls } = makeMockBackend();
    const embeddedVid = new Video({
      filename: "pkg.slp",
      backend,
      embedded: true,
      openBackend: false,
    });
    const pkgLabels = new Labels({ videos: [embeddedVid] });
    await ensureProjectPreviewFrame(pkgLabels, {
      currentVideo: embeddedVid,
      currentFrameIdx: 0,
    });
    expect(getCalls()).toEqual([]);
    expect(pkgLabels.previewFrames).toHaveLength(0);

    const linkedVid = new Video({ filename: "v.mp4", backend, openBackend: false });
    const existing = new PreviewFrame({
      video: linkedVid,
      frameIdx: 9,
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      width: 100,
      height: 100,
      origWidth: 100,
      origHeight: 100,
    });
    const labels = new Labels({ videos: [linkedVid] });
    labels.previewFrames = [existing];
    await ensureProjectPreviewFrame(labels, {
      currentVideo: linkedVid,
      currentFrameIdx: 0,
    });
    expect(getCalls()).toEqual([]);
    expect(labels.previewFrames).toEqual([existing]);
  });

  test("never throws when frame decoding fails", async () => {
    const failingBackend: VideoBackend = {
      filename: "broken.mp4",
      shape: [5, 100, 100, 3],
      async getFrame() {
        throw new Error("decode failed");
      },
      close() {},
    };
    const video = new Video({
      filename: "broken.mp4",
      backend: failingBackend,
      openBackend: false,
    });
    const labels = new Labels({ videos: [video] });
    await expect(
      ensureProjectPreviewFrame(labels, { currentVideo: video, currentFrameIdx: 0 }),
    ).resolves.toBeUndefined();
    expect(labels.previewFrames).toHaveLength(0);
  });
});
