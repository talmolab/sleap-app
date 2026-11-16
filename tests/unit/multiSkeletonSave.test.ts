/**
 * Save + reopen a two-skeleton project through the app's own Save path
 * (`saveProjectAsSlp`, desktop in-place branch) with the real sleap-io.js
 * writer — only the platform's file write is captured. Mice must come back as
 * mice and pellets as pellets.
 */

import { describe, it, expect, vi } from "../bun-test";

let written: Uint8Array | null = null;
const writeFileMock = vi.fn(async (_path: string, bytes: Uint8Array) => {
  written = bytes;
});

vi.mock("@/platform/index", () => ({
  isTauri: false,
  getPlatform: async () => ({
    isTauri: true,
    writeFile: writeFileMock,
    showSaveDialog: vi.fn(async () => null),
  }),
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { saveProjectAsSlp } = await import("@/lib/saveProject");
const { useAppStore } = await import("@/stores/appStore");
const { loadSlp } = await import("@talmolab/sleap-io.js");
const { makeTwoSkeletonProject } = await import("./multiSkeletonFixture");

describe("several skeletons: Save through the app", () => {
  // The user's ask (e) via the real Save code path, not just the io writer.
  it("writes both skeletons and each instance's skeleton", async () => {
    const { labels } = makeTwoSkeletonProject();
    useAppStore.getState().setLabels(labels, "two.slp");
    useAppStore.getState().set("projectPath", "/proj/two.slp");

    await saveProjectAsSlp(labels, "two.slp");

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(written).not.toBeNull();
    const bytes = written!;
    const reopened = await loadSlp(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { openVideos: false },
    );
    expect(reopened.skeletons.map((s) => s.name)).toEqual(["mouse", "pellet"]);
    const frame0 = reopened.labeledFrames.find((lf) => lf.frameIdx === 0)!;
    expect(frame0.instances.map((i) => i.skeleton.name)).toEqual(["mouse", "mouse", "pellet"]);
    expect(frame0.instances.map((i) => i.points.length)).toEqual([3, 3, 1]);
  });
});
