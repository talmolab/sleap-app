/**
 * Tests for export utility functions.
 */

import { describe, it, expect } from "../bun-test";
import {
  generateCSV,
  suggestSaveFilename,
} from "@/lib/exportUtils";
import {
  Labels,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

/** Create a minimal project for CSV testing. */
function createProjectForCSV(opts?: {
  withPredictions?: boolean;
  withTracks?: boolean;
  numFrames?: number;
}) {
  const numFrames = opts?.numFrames ?? 2;
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "test" });

  const video = {
    filename: "video.mp4",
    shape: [100, 480, 640, 3] as [number, number, number, number],
    backend: null,
    sourceVideo: null,
    backendMetadata: {},
  } as unknown as Video;

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
  });

  const tracks: Track[] = [];
  if (opts?.withTracks) {
    const t = new Track("Track 1");
    labels.tracks.push(t);
    tracks.push(t);
  }

  for (let f = 0; f < numFrames; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f * 5 });

    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [10 + f, 20 + f];
    inst.points[0].visible = true;
    inst.points[1].xy = [30 + f, 40 + f];
    inst.points[1].visible = true;

    if (opts?.withTracks && tracks.length > 0) {
      inst.track = tracks[0];
    }
    lf.instances.push(inst);

    if (opts?.withPredictions) {
      const pred = new PredictedInstance({
        skeleton,
        points: [
          { xy: [100, 200] as [number, number], visible: true, complete: true, name: "head", score: 0.95 },
          { xy: [NaN, NaN] as [number, number], visible: false, complete: false, name: "tail", score: 0.95 },
        ],
        score: 0.95,
      });
      lf.instances.push(pred);
    }

    labels.labeledFrames.push(lf);
  }

  return labels;
}

describe("generateCSV", () => {
  it("produces correct header", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "video_filename,frame_idx,track_name,instance_type,node_name,x,y,score,visible"
    );
  });

  it("produces correct number of data rows (sparse)", () => {
    const labels = createProjectForCSV({ numFrames: 2 });
    const csv = generateCSV(labels, { includeEmpty: false });
    const lines = csv.split("\n");

    // Header + 2 frames * 1 instance * 2 points = 5 lines
    expect(lines.length).toBe(5);
  });

  it("includes video filename", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    expect(lines[1]).toContain("video.mp4");
  });

  it("marks user instances correctly", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    // Data lines should have "user" as instance type
    expect(lines[1]).toContain(",user,");
  });

  it("marks predicted instances correctly", () => {
    const labels = createProjectForCSV({ numFrames: 1, withPredictions: true });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    // Some lines should have "predicted"
    const predictedLines = lines.filter((l) => l.includes(",predicted,"));
    expect(predictedLines.length).toBeGreaterThan(0);
  });

  it("handles NaN coordinates as empty strings", () => {
    const labels = createProjectForCSV({ numFrames: 1, withPredictions: true });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    // The predicted instance has NaN on second point
    // Find that line: should have empty x,y
    const predLine = lines.find(
      (l) => l.includes(",predicted,") && l.includes("tail")
    );
    expect(predLine).toBeDefined();
    // NaN coords should be empty strings in CSV
    if (predLine) {
      const cols = predLine.split(",");
      // x and y columns (indices 5, 6) should be empty
      expect(cols[5]).toBe("");
      expect(cols[6]).toBe("");
    }
  });

  it("includes track name when present", () => {
    const labels = createProjectForCSV({ numFrames: 1, withTracks: true });
    const csv = generateCSV(labels);

    expect(csv).toContain("Track 1");
  });

  it("handles empty labels (sparse)", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "test" });
    const video = {
      filename: "test.mp4",
      shape: [10, 10, 10, 3],
      backend: null,
    } as unknown as Video;
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });

    const csv = generateCSV(labels, { includeEmpty: false });
    const lines = csv.split("\n");
    // Only header
    expect(lines.length).toBe(1);
  });

  it("includes empty frame rows when includeEmpty is true", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    // Video has 100 frames (shape[0]), 1 labeled frame at index 0
    const csv = generateCSV(labels, { includeEmpty: true });
    const lines = csv.split("\n");

    // Header + 100 frames * 2 nodes = 201 lines
    // Frame 0 has 1 instance with 2 points, frames 1-99 have 2 empty rows each
    expect(lines.length).toBe(201);
  });

  it("defaults to includeEmpty true", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csvDefault = generateCSV(labels);
    const csvExplicit = generateCSV(labels, { includeEmpty: true });
    expect(csvDefault).toBe(csvExplicit);
  });

  it("empty frame rows have empty coordinates", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels, { includeEmpty: true });
    const lines = csv.split("\n");

    // Frame 1 (index 1) should be an empty row — no instance, just video+frame+node
    const frame1Lines = lines.filter((l) => l.startsWith("video.mp4,1,"));
    expect(frame1Lines.length).toBe(2); // 2 nodes
    for (const line of frame1Lines) {
      const cols = line.split(",");
      expect(cols[5]).toBe(""); // x
      expect(cols[6]).toBe(""); // y
    }
  });

  it("includes node names", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels);

    expect(csv).toContain("head");
    expect(csv).toContain("tail");
  });

  it("includes frame index", () => {
    const labels = createProjectForCSV({ numFrames: 1 });
    const csv = generateCSV(labels);
    const lines = csv.split("\n");

    // First data row should have frame index 0
    expect(lines[1]).toContain(",0,");
  });
});

describe("suggestSaveFilename", () => {
  it("appends .v002 to base filename", () => {
    const result = suggestSaveFilename("project.slp");
    expect(result).toBe("project.v002.json");
  });

  it("increments existing version number", () => {
    const result = suggestSaveFilename("project.v002.json");
    expect(result).toBe("project.v003.json");
  });

  it("handles higher version numbers", () => {
    const result = suggestSaveFilename("project.v099.json");
    expect(result).toBe("project.v100.json");
  });

  it("uses 'labels' as default when filename is null", () => {
    const result = suggestSaveFilename(null);
    expect(result).toBe("labels.v002.json");
  });

  it("strips .slp extension", () => {
    const result = suggestSaveFilename("my_project.slp");
    expect(result).toBe("my_project.v002.json");
  });

  it("strips .json extension", () => {
    const result = suggestSaveFilename("my_project.json");
    expect(result).toBe("my_project.v002.json");
  });

  it("pads version numbers to 3 digits", () => {
    const result = suggestSaveFilename("project.v001.json");
    expect(result).toBe("project.v002.json");
  });
});
