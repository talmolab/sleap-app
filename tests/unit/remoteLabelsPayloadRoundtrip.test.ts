/**
 * Real round trip (no mocking) for `buildRemoteLabelsPayload`: loads a real
 * fixture with the genuine `loadSlp`, builds an all-visible payload (so
 * `embed: false` — structure only, no pixel re-encoding), decodes the base64
 * back to bytes, and reloads it with the genuine `loadSlp` to confirm the
 * video filename was actually rewritten to the worker path on disk, not just
 * on the in-memory copy. Proves the full write->base64->decode->read path,
 * which `remoteLabelsPayload.test.ts`'s mocked `saveSlpToBytes` can't.
 */
import { describe, it, expect } from "../bun-test";
import { loadSlp } from "@talmolab/sleap-io.js";
import { buildRemoteLabelsPayload } from "@/lib/remoteLabelsPayload";
import type { VideoVisibility } from "@/lib/remoteVisibility";
import fs from "fs";
import path from "path";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

async function loadFixture(filename: string) {
  const filePath = path.join(FIXTURES_DIR, filename);
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return loadSlp(arrayBuffer, { openVideos: false });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("buildRemoteLabelsPayload (real round trip)", () => {
  it("re-points an all-visible video's filename and writes real .slp bytes", async () => {
    const labels = await loadFixture("centered_pair.slp");
    expect(labels.videos).toHaveLength(1);

    const workerPath = "/mnt/worker/centered_pair_low_quality.mp4";
    const visibility: VideoVisibility[] = [
      { index: 0, local: labels.videos[0].filename as string, worker: workerPath, visible: true },
    ];

    const payload = await buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict: false });

    expect(payload.embeddedVideos).toEqual([]);
    expect(payload.unavailableVideos).toEqual([]);
    expect(payload.bytes).toBeGreaterThan(0);

    // The original, in-memory Labels is untouched.
    expect(labels.videos[0].filename).not.toBe(workerPath);

    const bytes = base64ToBytes(payload.labelsContent);
    expect(bytes.byteLength).toBe(payload.bytes);

    const reloaded = await loadSlp(bytes, { openVideos: false });
    expect(reloaded.videos).toHaveLength(1);
    expect(reloaded.videos[0].filename).toBe(workerPath);
  });
});
