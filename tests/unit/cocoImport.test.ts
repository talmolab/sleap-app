/**
 * Tests for COCO keypoint-dataset import (File > Import > COCO...).
 *
 * Thin integration coverage: the sleap-io.js reader (`readCoco`) is exercised in
 * depth upstream, so here we verify the APP-specific wiring — that our loaders
 * JSON.parse the picked file, feed it to `readCoco`, and install the resulting
 * `Labels` into the store the same way opening a project does; that desktop
 * import resolves image paths relative to the JSON file's directory; that a
 * cancelled/invalid/non-COCO pick leaves NO partial state; and that the
 * `ImportCocoCommand` glues the platform picker to the loader.
 *
 * Mirrors analysisH5Import.test.ts: quiet toasts and stub video resolution (the
 * external image sequence never settles under the bun runner — that path runs
 * in a real WebView / Tauri).
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));

// Control the platform picker for the command-level test. The load helpers are
// exercised directly (path/File), so only the command needs the fake dialog.
let dialogResult: File | string | null = null;
let readFileBytes = new Uint8Array();
const showOpenDialogMock = vi.fn(async () => dialogResult);
vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: false,
    showOpenDialog: showOpenDialogMock,
    readFile: async () => readFileBytes,
    exists: async () => true,
  }),
  // loadProject imports this for the SLP File path; the COCO path never calls
  // it, but the binding must exist so the module import resolves.
  consumeLastBrowserFileHandle: () => null,
}));

import {
  loadCocoProjectFromFile,
  loadCocoProjectFromPath,
} from "@/lib/loadProject";
import { ImportCocoCommand } from "@/commands/fileCommands";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";

/** A minimal but complete COCO keypoints document: 1 category (3 nodes), 2
 *  images, one annotation each → 1 image-sequence video, 2 labeled frames. */
function makeCocoJson() {
  return {
    images: [
      { id: 1, file_name: "img1.png", height: 100, width: 120 },
      { id: 2, file_name: "sub/img2.png", height: 100, width: 120 },
    ],
    annotations: [
      { id: 1, image_id: 1, category_id: 1, keypoints: [10, 20, 2, 30, 40, 2, 0, 0, 0], num_keypoints: 2 },
      { id: 2, image_id: 2, category_id: 1, keypoints: [11, 21, 2, 31, 41, 2, 51, 61, 2], num_keypoints: 3 },
    ],
    categories: [
      { id: 1, name: "person", keypoints: ["nose", "eye", "ear"], skeleton: [[1, 2], [2, 3]] },
    ],
  };
}

const COCO_STRING = JSON.stringify(makeCocoJson());
const COCO_BYTES = () => new TextEncoder().encode(COCO_STRING);
const cocoFile = (name = "annotations.json") =>
  new File([COCO_STRING], name, { type: "application/json" });

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("loadCocoProjectFromFile (browser)", () => {
  beforeEach(resetStore);

  it("parses a COCO File into Labels and populates the store", async () => {
    const ok = await loadCocoProjectFromFile(cocoFile());
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    // Keypoint names become skeleton nodes.
    expect(state.skeleton!.nodes.map((n) => n.name)).toEqual(["nose", "eye", "ear"]);
    // One image-sequence video, one labeled frame per annotated image.
    expect(state.labels!.videos.length).toBe(1);
    expect(state.labels!.labeledFrames.length).toBe(2);
    expect(state.filename).toBe("annotations.json");
    expect(state.isLoading).toBe(false);
  });
});

describe("loadCocoProjectFromPath (desktop)", () => {
  beforeEach(resetStore);

  it("imports via readFile bytes and populates the store", async () => {
    const ok = await loadCocoProjectFromPath(
      "/data/ds/annotations.json",
      async () => COCO_BYTES(),
      async () => true
    );
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    expect(state.labels!.labeledFrames.length).toBe(2);
    expect(state.skeleton!.nodes.length).toBe(3);
    expect(state.isLoading).toBe(false);
  });

  it("resolves image paths relative to the JSON file's directory", async () => {
    await loadCocoProjectFromPath(
      "/data/ds/annotations.json",
      async () => COCO_BYTES(),
      async () => true
    );

    const fn = useAppStore.getState().labels!.videos[0].filename;
    const first = Array.isArray(fn) ? fn[0] : fn;
    // datasetRoot = dirname(json) → "img1.png" resolves under it.
    expect(first).toBe("/data/ds/img1.png");
  });
});

describe("COCO import error handling (no partial state)", () => {
  beforeEach(resetStore);

  it("returns false and leaves the store empty on invalid JSON", async () => {
    const bad = new File(["{ not json"], "broken.json");
    const ok = await loadCocoProjectFromFile(bad);
    expect(ok).toBe(false);

    const state = useAppStore.getState();
    expect(state.labels).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("returns false and leaves the store empty on valid-JSON-but-not-COCO", async () => {
    const notCoco = new File([JSON.stringify({ foo: 1, bar: [] })], "other.json");
    const ok = await loadCocoProjectFromFile(notCoco);
    expect(ok).toBe(false);

    const state = useAppStore.getState();
    expect(state.labels).toBeNull();
    expect(state.isLoading).toBe(false);
  });
});

describe("ImportCocoCommand (menu wiring)", () => {
  beforeEach(() => {
    resetStore();
    dialogResult = null;
    readFileBytes = new Uint8Array();
    showOpenDialogMock.mockClear();
  });

  it("loads the picked COCO file and installs Labels", async () => {
    dialogResult = cocoFile();
    const ctx = new CommandContext();
    await ctx.execute(ImportCocoCommand);

    expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    expect(state.labels!.labeledFrames.length).toBe(2);
  });

  it("does nothing when the picker is cancelled", async () => {
    dialogResult = null;
    const ctx = new CommandContext();
    await ctx.execute(ImportCocoCommand);

    expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().labels).toBeNull();
  });
});
