/**
 * Structural tests: `@talmolab/sleap-io.js`'s `saveSlpToBytes` is mocked for
 * every test in this file (bun's `--isolate` gives this file its own module
 * registry, and `@/lib/remoteLabelsPayload` is only ever imported here AFTER
 * the mock is installed — see "../bun-test"'s `vi.mock` caveat). A separate
 * file (`remoteLabelsPayloadRoundtrip.test.ts`) covers the real
 * `saveSlpToBytes`/`loadSlp` round trip on a fixture — it can't live in this
 * file, since once `@/lib/remoteLabelsPayload` is first imported here (bound
 * to the mock below), bun's module cache would keep serving that same bound
 * instance to any later test in this file, mock or not.
 *
 * Call args are captured through closures (`capturedLabelsArg`/
 * `capturedOptions`) rather than read back off `saveSlpToBytesMock.mock.calls`
 * — the bun-test `vi.fn` shim widens the impl to `(...args: never[]) =>
 * unknown`, which makes `.mock.calls[i][j]` element types unusable without
 * casts (see saveInPlaceRouting.test.ts's header comment for the same note).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import type { Labels } from "@/types";

interface FakeVideo {
  filename: string | string[];
  backend: unknown;
  backendMetadata?: Record<string, unknown>;
}

/** A `Labels`-shaped fake whose `.copy()` deep-copies `videos` (mirrors the real `Labels.copy()` contract this module relies on). */
function makeLabels(videos: FakeVideo[]): Labels {
  const cloneVideo = (v: FakeVideo): FakeVideo => ({
    ...v,
    filename: Array.isArray(v.filename) ? [...v.filename] : v.filename,
    backendMetadata: v.backendMetadata ? { ...v.backendMetadata } : undefined,
  });
  const original = videos.map(cloneVideo);
  return {
    videos: original,
    copy: () => ({ videos: original.map(cloneVideo) }),
  } as unknown as Labels;
}

let capturedLabelsArg: { videos: FakeVideo[] } | null = null;
let capturedOptions: { embed: boolean | string } | null = null;
const saveSlpToBytesMock = vi.fn(async (labelsArg: { videos: FakeVideo[] }, options: { embed: boolean | string }) => {
  capturedLabelsArg = labelsArg;
  capturedOptions = options;
  return new Uint8Array([1, 2, 3]);
});
vi.mock("@talmolab/sleap-io.js", () => ({
  saveSlpToBytes: saveSlpToBytesMock,
}));

async function importSut() {
  return import("@/lib/remoteLabelsPayload");
}

function visible(index: number, local: string, worker: string) {
  return { index, local, worker, visible: true } as const;
}
function hidden(index: number, local: string, reason: "not-found" | "no-location" = "not-found") {
  return { index, local, worker: null, visible: false, reason } as const;
}

describe("buildRemoteLabelsPayload", () => {
  beforeEach(() => {
    saveSlpToBytesMock.mockClear();
    capturedLabelsArg = null;
    capturedOptions = null;
  });

  it("all visible: re-points every video's filename/backendMetadata.filename, clears backend, embed: false", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([
      { filename: "/local/a.mp4", backend: { kind: "mp4" }, backendMetadata: { filename: "/local/a.mp4" } },
    ]);
    const visibility = [visible(0, "/local/a.mp4", "/mnt/worker/a.mp4")];

    const result = await buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict: false });

    expect(saveSlpToBytesMock).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toEqual({ embed: false });
    expect(capturedLabelsArg?.videos[0]).toMatchObject({
      filename: "/mnt/worker/a.mp4",
      backend: null,
      backendMetadata: { filename: "/mnt/worker/a.mp4" },
    });
    expect(result).toEqual({
      labelsContent: expect.any(String),
      bytes: 3,
      embeddedVideos: [],
      unavailableVideos: [],
    });
  });

  it("never mutates the original labels object", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([{ filename: "/local/a.mp4", backend: { kind: "mp4" } }]);
    const originalVideoSnapshot: FakeVideo = { ...(labels.videos[0] as unknown as FakeVideo) };

    await buildRemoteLabelsPayload(labels, [visible(0, "/local/a.mp4", "/mnt/worker/a.mp4")], {
      embedFramesToPredict: false,
    });

    expect(labels.videos[0] as unknown as FakeVideo).toEqual(originalVideoSnapshot);
  });

  it("a hidden video with a backend keeps its local filename/backend and is embedded (embed: 'all')", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([{ filename: "/local/hidden.mp4", backend: { kind: "mp4" } }]);

    const result = await buildRemoteLabelsPayload(labels, [hidden(0, "/local/hidden.mp4")], {
      embedFramesToPredict: false,
    });

    expect(capturedOptions).toEqual({ embed: "all" });
    expect(capturedLabelsArg?.videos[0]).toMatchObject({
      filename: "/local/hidden.mp4",
      backend: { kind: "mp4" },
    });
    expect(result.embeddedVideos).toEqual([0]);
    expect(result.unavailableVideos).toEqual([]);
  });

  it("embedFramesToPredict requests 'all+suggestions' instead of 'all'", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([{ filename: "/local/hidden.mp4", backend: { kind: "mp4" } }]);

    await buildRemoteLabelsPayload(labels, [hidden(0, "/local/hidden.mp4")], {
      embedFramesToPredict: true,
    });

    expect(capturedOptions).toEqual({ embed: "all+suggestions" });
  });

  it("a hidden video with no backend is reported unavailable, not embedded, but 'all' is still requested for the other hidden video", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([
      { filename: "/local/no-backend.mp4", backend: null },
      { filename: "/local/has-backend.mp4", backend: { kind: "mp4" } },
    ]);

    const result = await buildRemoteLabelsPayload(
      labels,
      [hidden(0, "/local/no-backend.mp4"), hidden(1, "/local/has-backend.mp4")],
      { embedFramesToPredict: false },
    );

    expect(capturedOptions).toEqual({ embed: "all" });
    expect(result.unavailableVideos).toEqual([0]);
    expect(result.embeddedVideos).toEqual([1]);
  });

  it("requests 'all' even when every hidden video lacks a backend (nothing ends up actually embedded)", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([{ filename: "/local/no-backend.mp4", backend: null }]);

    const result = await buildRemoteLabelsPayload(labels, [hidden(0, "/local/no-backend.mp4")], {
      embedFramesToPredict: false,
    });

    expect(capturedOptions).toEqual({ embed: "all" });
    expect(result.unavailableVideos).toEqual([0]);
    expect(result.embeddedVideos).toEqual([]);
  });

  it("mixes visible and hidden videos in one payload", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([
      { filename: "/local/visible.mp4", backend: { kind: "mp4" } },
      { filename: "/local/hidden.mp4", backend: { kind: "mp4" } },
    ]);

    const result = await buildRemoteLabelsPayload(
      labels,
      [visible(0, "/local/visible.mp4", "/mnt/worker/visible.mp4"), hidden(1, "/local/hidden.mp4")],
      { embedFramesToPredict: false },
    );

    const videos = capturedLabelsArg?.videos ?? [];
    expect(videos[0]).toMatchObject({ filename: "/mnt/worker/visible.mp4", backend: null });
    expect(videos[1]).toMatchObject({ filename: "/local/hidden.mp4", backend: { kind: "mp4" } });
    expect(result.embeddedVideos).toEqual([1]);
  });

  it("a video missing from the visibility array is treated as hidden (conservative default)", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const labels = makeLabels([{ filename: "/local/a.mp4", backend: { kind: "mp4" } }]);

    const result = await buildRemoteLabelsPayload(labels, [], { embedFramesToPredict: false });

    expect(capturedOptions).toEqual({ embed: "all" });
    expect(result.embeddedVideos).toEqual([0]);
  });
});

describe("image-sequence videos", () => {
  it("re-points every frame file of a visible image sequence, not just the first", async () => {
    const { buildRemoteLabelsPayload } = await importSut();
    const frames = ["/Volumes/talmo/exp1/frames/0001.png", "/Volumes/talmo/exp1/frames/0002.png"];
    const labels = makeLabels([{ filename: frames, backend: { kind: "images" } }]);
    const visibility = [visible(0, frames[0], "/root/vast/exp1/frames/0001.png")];

    await buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict: false });

    expect(capturedLabelsArg?.videos[0].filename).toEqual([
      "/root/vast/exp1/frames/0001.png",
      "/root/vast/exp1/frames/0002.png",
    ]);
    expect(capturedLabelsArg?.videos[0].backend).toBeNull();
    expect(labels.videos[0].filename).toEqual(frames); // original untouched
  });
});
