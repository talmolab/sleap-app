/**
 * Compare Model Predictions: finding prediction files near the project, the
 * store of shown models, and which poses the canvas draws on a frame.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { Labels } from "@talmolab/sleap-io.js";
import { scanPredictionFiles, MAX_SCAN_BYTES, type SlpScanFs } from "@/lib/modelOverlay/scan";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useAppStore } from "@/stores/appStore";
import { modelOverlayLayers } from "@/hooks/useModelOverlayFrame";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import { makeVideo } from "./modelOverlayTestData";

/** A fake folder tree: path → entries; files listed with a size. */
function fakeFs(tree: Record<string, (string | [string, number])[]>): SlpScanFs {
  const sizes = new Map<string, number>();
  return {
    async readDir(path) {
      const entries = tree[path];
      if (!entries) throw new Error("no such folder");
      return entries.map((e) => {
        const name = Array.isArray(e) ? e[0] : e;
        if (Array.isArray(e)) sizes.set(`${path}/${name}`, e[1]);
        return { name, isDirectory: !Array.isArray(e) };
      });
    },
    async stat(path) {
      return { size: sizes.get(path) ?? null, mtime: sizes.has(path) ? 1000 : null };
    },
  };
}

describe("scanPredictionFiles", () => {
  // The user decided: look in the project folder, models/ and each run folder under it.
  it("lists .slp files in the project folder, models/ and models/<run>/, skipping the project", async () => {
    const fs = fakeFs({
      "/p": [["labels.slp", 10], ["preds.slp", 20], ["notes.txt", 1], "models"],
      "/p/models": [["all.slp", 5], "run1", "run2"],
      "/p/models/run1": [["labels_pr.slp", 7], ["best.ckpt", 9]],
      // run2 can't be read: skipped, not an error.
    });
    const found = await scanPredictionFiles("/p/labels.slp", fs);
    expect(found.map((f) => f.path)).toEqual(["/p/models/all.slp", "/p/models/run1/labels_pr.slp", "/p/preds.slp"]);
    expect(found[1].size).toBe(7);
  });

  // No saved project → nowhere to look (the dialog then offers Browse… only).
  it("returns nothing without a project path", async () => {
    expect(await scanPredictionFiles(null, fakeFs({}))).toEqual([]);
  });

  // Sanity: the size cap is large enough for ordinary prediction files.
  it("caps automatic checks at 1 GB", () => {
    expect(MAX_SCAN_BYTES).toBe(1024 ** 3);
  });
});

function pose(x: number, y: number): OverlayPose {
  return { xy: new Float64Array([x, y]), score: null, trackName: null };
}

describe("modelOverlayStore", () => {
  beforeEach(() => {
    useModelOverlayStore.getState().clear();
  });

  // Each model gets its own colour, and loading the same file again replaces it.
  it("adds models with distinct colours and replaces a re-added source", () => {
    const labels = new Labels();
    const video = makeVideo();
    const s = useModelOverlayStore.getState();
    s.addModels(labels, [
      { name: "a", source: "/a.slp", video, frames: new Map() },
      { name: "b", source: "/b.slp", video, frames: new Map() },
    ]);
    s.setVisible(useModelOverlayStore.getState().models[0].id, false);
    s.addModels(labels, [{ name: "a2", source: "/a.slp", video, frames: new Map([[1, [pose(1, 1)]]]) }]);
    const models = useModelOverlayStore.getState().models;
    expect(models.map((m) => m.name)).toEqual(["a2", "b"]);
    expect(models[0].color).toEqual(MODEL_COLORS[0]);
    expect(models[1].color).toEqual(MODEL_COLORS[1]);
    expect(models[0].visible).toBe(true);
  });

  // Overlays belong to one project; opening another must not show stale poses.
  it("clears when a different project loads", () => {
    const labels = new Labels();
    useModelOverlayStore.getState().addModels(labels, [{ name: "a", source: "/a.slp", video: makeVideo(), frames: new Map() }]);
    useAppStore.setState({ labels: new Labels() });
    expect(useModelOverlayStore.getState().models).toEqual([]);
  });
});

describe("modelOverlayLayers", () => {
  // The canvas draws only visible models loaded for the video on screen, on this frame.
  it("picks visible models for this video and frame", () => {
    const v1 = makeVideo("/v1.mp4");
    const v2 = makeVideo("/v2.mp4");
    const base = { source: "", color: MODEL_COLORS[0], visible: true, trackNames: new Set<string>() };
    const layers = modelOverlayLayers(
      [
        { ...base, id: "a", name: "a", video: v1, frames: new Map([[4, [pose(1, 2)]]]) },
        { ...base, id: "b", name: "b", video: v1, frames: new Map([[4, [pose(3, 4)]]]), visible: false },
        { ...base, id: "c", name: "c", video: v2, frames: new Map([[4, [pose(5, 6)]]]) },
        { ...base, id: "d", name: "d", video: v1, frames: new Map([[5, [pose(7, 8)]]]) },
      ],
      v1,
      4
    );
    expect(layers.map((l) => l.modelId)).toEqual(["a"]);
  });
});
