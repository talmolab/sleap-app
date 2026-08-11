/**
 * Tests for DeepLabCut import (File > Import > DeepLabCut dataset... / Multiple
 * DeepLabCut datasets from folder...).
 *
 * Thin integration coverage: the sleap-io.js readers (`readDlc`/`readDlcProject`)
 * are exercised in depth upstream, so here we verify the APP-specific wiring —
 * the pure `createDlcFileSystem` seam, that `loadDlcFromFileSystem` feeds an
 * in-memory DLC tree to the reader and installs the resulting `Labels` into the
 * store, that "single" auto-detects a project (config.yaml) vs a bare dataset
 * CSV, that "folder" merges every subdir dataset into one project, and that a
 * folder with no DLC content leaves NO partial state.
 *
 * Mirrors cocoImport.test.ts: quiet toasts and stub video resolution (image
 * sequences never settle under the bun runner — that path runs in a real
 * WebView / Tauri).
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

import { createDlcFileSystem } from "@/lib/dlcFileSystem";
import { loadDlcFromFileSystem } from "@/lib/loadProject";
import { useAppStore } from "@/stores/appStore";

// ---------------------------------------------------------------------------
// Fixtures: minimal DLC trees keyed by absolute POSIX path.
// ---------------------------------------------------------------------------

const SADLC_CSV = [
  "scorer,LM,LM,LM,LM,LM,LM",
  "bodyparts,A,A,B,B,C,C",
  "coords,x,y,x,y,x,y",
  "labeled-data/vid1/img000.png,0,1,2,3,4,5",
  "labeled-data/vid1/img001.png,10,11,12,13,14,15",
  "",
].join("\n");

const CONFIG = [
  "Task: proj",
  "scorer: LM",
  "bodyparts:",
  "- A",
  "- B",
  "- C",
  "skeleton:",
  "- - A",
  "  - B",
  "- - B",
  "  - C",
  "video_sets:",
  '  "/p/videos/vid1.mp4": {}',
  "",
].join("\n");

/** A full DLC project rooted at /p (config.yaml + one labeled-data folder). */
function projectFs() {
  return createDlcFileSystem(
    new Map([
      ["/p/config.yaml", CONFIG],
      ["/p/labeled-data/vid1/CollectedData_LM.csv", SADLC_CSV],
    ]),
    ["/p/labeled-data/vid1/img000.png", "/p/labeled-data/vid1/img001.png"],
  );
}

/** A bare single-dataset folder rooted at /d (a CSV + images, NO config). */
function bareDatasetFs() {
  return createDlcFileSystem(
    new Map([["/d/CollectedData_LM.csv", SADLC_CSV]]),
    ["/d/labeled-data/vid1/img000.png", "/d/labeled-data/vid1/img001.png"],
  );
}

/** A parent folder /m with two dataset subdirs, each a CSV + images. */
function multiFolderFs() {
  const csv2 = SADLC_CSV.replace(/vid1/g, "vid2");
  return createDlcFileSystem(
    new Map([
      ["/m/video1/CollectedData_LM.csv", SADLC_CSV],
      ["/m/video2/CollectedData_LM.csv", csv2],
    ]),
    [
      "/m/video1/labeled-data/vid1/img000.png",
      "/m/video1/labeled-data/vid1/img001.png",
      "/m/video2/labeled-data/vid2/img000.png",
      "/m/video2/labeled-data/vid2/img001.png",
    ],
  );
}

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("createDlcFileSystem (pure seam)", () => {
  it("answers exists/isFile/isDirectory/readTextFile/readDir over a path map", () => {
    const fs = projectFs();
    expect(fs.exists("/p/config.yaml")).toBe(true);
    expect(fs.isFile("/p/config.yaml")).toBe(true);
    expect(fs.isDirectory("/p/labeled-data")).toBe(true);
    expect(fs.isDirectory("/p/config.yaml")).toBe(false);
    expect(fs.exists("/p/nope")).toBe(false);
    expect(fs.readTextFile("/p/config.yaml")).toContain("Task: proj");
    // readDir returns immediate child names only.
    expect(fs.readDir("/p").sort()).toEqual(["config.yaml", "labeled-data"]);
    expect(fs.readDir("/p/labeled-data")).toEqual(["vid1"]);
    // Image paths exist but are not readable as text.
    expect(fs.exists("/p/labeled-data/vid1/img000.png")).toBe(true);
    expect(() => fs.readTextFile("/p/labeled-data/vid1/img000.png")).toThrow();
  });
});

describe("loadDlcFromFileSystem single mode", () => {
  beforeEach(resetStore);

  it("imports a DLC project (config.yaml) and populates the store", async () => {
    const ok = await loadDlcFromFileSystem(projectFs(), "/p", "single", "p");
    expect(ok).toBe(true);
    const state = useAppStore.getState();
    expect(state.labels).not.toBeNull();
    expect(state.skeleton!.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    // config edges applied
    expect(state.skeleton!.edges.length).toBe(2);
    expect(state.labels!.labeledFrames.length).toBe(2);
    expect(state.isLoading).toBe(false);
  });

  it("imports a bare single-dataset folder (CSV, no config.yaml)", async () => {
    const ok = await loadDlcFromFileSystem(bareDatasetFs(), "/d", "single", "d");
    expect(ok).toBe(true);
    const state = useAppStore.getState();
    expect(state.skeleton!.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    expect(state.labels!.labeledFrames.length).toBe(2);
  });
});

describe("loadDlcFromFileSystem folder mode", () => {
  beforeEach(resetStore);

  it("merges every subdir dataset into one project", async () => {
    const ok = await loadDlcFromFileSystem(multiFolderFs(), "/m", "folder", "m");
    expect(ok).toBe(true);
    const state = useAppStore.getState();
    // One unified skeleton (same node names across datasets).
    expect(state.labels!.skeletons.length).toBe(1);
    expect(state.skeleton!.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    // Two videos (one per dataset), four labeled frames total.
    expect(state.labels!.videos.length).toBe(2);
    expect(state.labels!.labeledFrames.length).toBe(4);
  });
});

describe("loadDlcFromFileSystem single mode with an explicit picked file", () => {
  beforeEach(resetStore);

  it("honors a picked config .yaml with a NON-standard name (not `config.yaml`)", async () => {
    const fs = createDlcFileSystem(
      new Map([
        // Config is NOT named config.yaml — the picked-file path must still be
        // used directly as the project config.
        ["/p/madlc_230_config.yaml", CONFIG],
        ["/p/labeled-data/vid1/CollectedData_LM.csv", SADLC_CSV],
      ]),
      ["/p/labeled-data/vid1/img000.png", "/p/labeled-data/vid1/img001.png"],
    );
    const ok = await loadDlcFromFileSystem(fs, "/p", "single", "p", undefined, {
      entryFile: "/p/madlc_230_config.yaml",
    });
    expect(ok).toBe(true);
    const state = useAppStore.getState();
    expect(state.skeleton!.nodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    expect(state.skeleton!.edges.length).toBe(2);
    expect(state.labels!.labeledFrames.length).toBe(2);
  });

  it("loads ONLY the picked CSV when a folder has several", async () => {
    const other = SADLC_CSV.replace(/vid1/g, "vidX");
    const fs = createDlcFileSystem(
      new Map([
        ["/d/CollectedData_LM.csv", SADLC_CSV],
        ["/d/OtherData.csv", other],
      ]),
      [
        "/d/labeled-data/vid1/img000.png",
        "/d/labeled-data/vid1/img001.png",
        "/d/labeled-data/vidX/img000.png",
        "/d/labeled-data/vidX/img001.png",
      ],
    );
    const ok = await loadDlcFromFileSystem(fs, "/d", "single", "d", undefined, {
      entryFile: "/d/CollectedData_LM.csv",
    });
    expect(ok).toBe(true);
    // Only the picked CSV's single video/frames — NOT both CSVs merged.
    expect(useAppStore.getState().labels!.videos.length).toBe(1);
    expect(useAppStore.getState().labels!.labeledFrames.length).toBe(2);
  });
});

describe("DLC import error handling (no partial state)", () => {
  beforeEach(resetStore);

  it("returns false and leaves the store empty when no DLC content is found", async () => {
    const empty = createDlcFileSystem(new Map(), ["/x/readme.txt"]);
    const ok = await loadDlcFromFileSystem(empty, "/x", "single", "x");
    expect(ok).toBe(false);
    const state = useAppStore.getState();
    expect(state.labels).toBeNull();
    expect(state.isLoading).toBe(false);
  });
});
