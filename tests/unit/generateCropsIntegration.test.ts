/**
 * Integration test for generateCrops against a real fixture (issue #212).
 *
 * Exercises the actual sleap-io.js `Video.crop({center,size})` call and the
 * crop-project assembly on a loaded .slp — the part the pure math tests can't
 * cover. Uses `openVideos: false` so no browser video backend is needed.
 */

import { describe, it, expect } from "../bun-test";
import { loadSlp, Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import fs from "fs";
import path from "path";
import { generateCrops } from "@/lib/activeLearning/generateCrops";
import { normalizeActiveLearningConfig } from "@/lib/activeLearning/config";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

async function loadFixture(filename: string) {
  const buffer = fs.readFileSync(path.join(FIXTURES_DIR, filename));
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return loadSlp(arrayBuffer, { openVideos: false });
}

describe("generateCrops integration", () => {
  // Fixtures load with `openVideos: false`, so the source video has no open
  // backend and Video.crop must be skipped — this asserts the graceful-skip
  // path (the crop happy path needs a browser video backend, verified in-app).
  it("reads a real fixture and skips instances whose video backend isn't open", async () => {
    const labels = await loadFixture("centered_pair.slp");
    const config = normalizeActiveLearningConfig({
      localize: { cropSize: 128 },
    });

    const totalUserInstances = labels.labeledFrames.reduce(
      (acc, lf) => acc + lf.userInstances.length,
      0,
    );
    expect(totalUserInstances).toBeGreaterThan(0);

    // Must not throw even though no backend is open.
    const result = generateCrops(labels, config, { from: "user" });

    // With no open backend, every centered instance is counted as "unopened",
    // nothing is cropped, and no crash occurs.
    expect(result.count).toBe(0);
    expect(result.unopened).toBeGreaterThan(0);
    expect(result.count + result.skipped + result.unopened).toBe(totalUserInstances);
    expect(result.labels.videos.length).toBe(0);
  });

  it("produces virtual crop videos with the right rect when the backend is open", () => {
    // A stub backend is enough: Video.crop only requires a non-null backend
    // (it wraps it into a CropVideoBackend; it does not decode here).
    const shape: [number, number, number, number] = [10, 480, 640, 1];
    const stubBackend = {
      shape,
      getFrame: async () => null,
    } as unknown as NonNullable<Video["backend"]>;
    const video = new Video({ filename: "stub.mp4", backend: stubBackend, shape });

    const skeleton = new Skeleton({ nodes: ["body_center", "head"], name: "test" });
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [300, 240];
    inst.points[0].visible = true;
    inst.points[0].complete = true;

    const labels = new Labels({
      videos: [video],
      skeletons: [skeleton],
      labeledFrames: [new LabeledFrame({ video, frameIdx: 5, instances: [inst] })],
    });

    const config = normalizeActiveLearningConfig({
      localize: { cropSize: 128, centroidNode: "body_center" },
    });
    const result = generateCrops(labels, config, { from: "user" });

    expect(result.count).toBe(1);
    expect(result.unopened).toBe(0);
    expect(result.labels.videos.length).toBe(1);

    const cropFrame = result.labels.labeledFrames[0];
    expect(cropFrame.frameIdx).toBe(5); // source frame index preserved
    // Centered on (300,240) with 128px side → [236,176,364,304] (x2/y2 exclusive).
    expect(cropFrame.video.cropRect).toEqual([236, 176, 364, 304]);
    // The crop instance carries the anchor point (in source coords).
    expect(cropFrame.instances[0].points[0].xy).toEqual([300, 240]);
    expect(cropFrame.instances[0].points[0].visible).toBe(true);
  });
});
