/**
 * Tests for the Export Labels Package feature (embedded-image `.pkg.slp`).
 *
 * Covers the pure helpers (level → embed-mode mapping, filename derivation,
 * frame-count selectors) and the CRITICAL io round-trip: does an embedded
 * package written via `saveSlpToBytes({ embed })` reload with frames + images
 * intact? The round-trip is exercised for BOTH the mp4-backed source case (io's
 * key risk — see below) and an encoded-bytes source that models an
 * already-embedded `pkg.slp`.
 *
 * ── KEY FINDING (mp4-source embed) ────────────────────────────────────────────
 * io only embeds a frame when the video backend's `getFrame()` yields ENCODED
 * bytes (Uint8Array / ArrayBuffer). The continuous-video backends (MediaBunny /
 * Mp4Box) return an `ImageBitmap`, which io's `frameToBytes()` rejects, so a
 * continuous/mp4 source embeds NO images — the package references the source
 * video instead. Encoded-byte sources (already-embedded pkg.slp) round-trip
 * byte-exact. These tests assert both behaviours so the gap is regression-locked.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  Skeleton,
  Instance,
  PredictedInstance,
  LabeledFrame,
  SuggestionFrame,
  Video,
  saveSlpToBytes,
  loadSlp,
} from "@talmolab/sleap-io.js";
import {
  embedModeForLevel,
  derivePackageFilename,
  countUserFrames,
  countTrainingFrames,
  countFullFrames,
  frameCountForLevel,
  labelsForLevel,
  packageLeavesFramesUnembedded,
} from "@/commands/exportPackageCommands";
import fs from "fs";
import os from "os";
import path from "path";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

/** A valid 1x1 PNG (69 bytes) — a stand-in for an encoded embedded frame. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function loadFixtureBytes(name: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(FIXTURES_DIR, name));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer;
}

/** Detached ArrayBuffer copy of a Uint8Array (typed as ArrayBuffer, not …Like). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength
  ) as ArrayBuffer;
}

describe("Export Labels Package — level → embed-mode mapping", () => {
  it("maps user → 'user' (PyQt Level 1)", () => {
    expect(embedModeForLevel("user")).toBe("user");
  });
  it("maps training → 'user+suggestions' (PyQt Level 2)", () => {
    expect(embedModeForLevel("training")).toBe("user+suggestions");
  });
  it("maps full → 'all' (PyQt Level 3; suggestion images pending io all+suggestions)", () => {
    expect(embedModeForLevel("full")).toBe("all");
  });
});

describe("Export Labels Package — filename derivation", () => {
  it("strips .slp and appends .pkg.slp", () => {
    expect(derivePackageFilename("session.slp")).toBe("session.pkg.slp");
  });
  it("strips .json and appends .pkg.slp", () => {
    expect(derivePackageFilename("labels.json")).toBe("labels.pkg.slp");
  });
  it("does not double a .pkg suffix", () => {
    expect(derivePackageFilename("x.pkg.slp")).toBe("x.pkg.slp");
  });
  it("keeps a path prefix and dotted base intact", () => {
    expect(derivePackageFilename("/a/b/my.session.slp")).toBe(
      "/a/b/my.session.pkg.slp"
    );
  });
  it("defaults to 'labels.pkg.slp' when filename is null", () => {
    expect(derivePackageFilename(null)).toBe("labels.pkg.slp");
  });
});

describe("Export Labels Package — frame-count selectors", () => {
  /**
   * Build a project with:
   *  - frame 0: user instance          (user-labeled)
   *  - frame 1: predicted-only         (labeled, NOT user-labeled)
   *  - suggestion at frame 0           (coincides with a user frame)
   *  - suggestion at frame 5           (new, unlabeled)
   */
  function makeProject(): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({
      filename: "clip.mp4",
      backendMetadata: { shape: [10, 2, 2, 1] },
      openBackend: false,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });

    const userInst = Instance.empty({ skeleton });
    userInst.points[0].xy = [1, 1];
    userInst.points[0].visible = true;
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 0, instances: [userInst] })
    );

    const pred = PredictedInstance.fromArray([[2, 2], [3, 3]], skeleton, 0.9);
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 1, instances: [pred] })
    );

    labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 0 }));
    labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 5 }));
    return labels;
  }

  it("user count = user-labeled frames only", () => {
    expect(countUserFrames(makeProject())).toBe(1);
  });

  it("training count = user ∪ suggestions (dedup coincident frame)", () => {
    // user {0}, suggestions {0,5} → {0,5} → 2
    expect(countTrainingFrames(makeProject())).toBe(2);
  });

  it("full count = all labeled ∪ suggestions", () => {
    // labeled {0,1}, suggestions {0,5} → {0,1,5} → 3
    expect(countFullFrames(makeProject())).toBe(3);
  });

  it("frameCountForLevel dispatches per level", () => {
    const labels = makeProject();
    expect(frameCountForLevel(labels, "user")).toBe(1);
    expect(frameCountForLevel(labels, "training")).toBe(2);
    expect(frameCountForLevel(labels, "full")).toBe(3);
  });
});

describe("Export Labels Package — per-level frame selection", () => {
  /**
   * frame 0: user instance; frame 1: predicted-only; frame 2: predicted-only;
   * suggestions at frame 0 (coincident) and frame 5 (unlabeled).
   * A realistic post-inference project: a few user labels amid many predictions.
   */
  function makeProject(): Labels {
    const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
    const video = new Video({
      filename: "clip.mp4",
      backendMetadata: { shape: [10, 2, 2, 1] },
      openBackend: false,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });

    const userInst = Instance.empty({ skeleton });
    userInst.points[0].xy = [1, 1];
    userInst.points[0].visible = true;
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 0, instances: [userInst] })
    );
    for (const frameIdx of [1, 2]) {
      const pred = PredictedInstance.fromArray([[2, 2], [3, 3]], skeleton, 0.9);
      labels.labeledFrames.push(
        new LabeledFrame({ video, frameIdx, instances: [pred] })
      );
    }
    labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 0 }));
    labels.suggestions.push(new SuggestionFrame({ video, frameIdx: 5 }));
    return labels;
  }

  it("user: drops predicted-only frames (keeps only user-labeled)", () => {
    const subset = labelsForLevel(makeProject(), "user");
    expect(subset.labeledFrames.length).toBe(1);
    expect(subset.labeledFrames[0].frameIdx).toBe(0);
    expect(subset.labeledFrames.every((f) => f.hasUserInstances)).toBe(true);
  });

  it("training: drops predicted-only frames but carries suggestions", () => {
    const subset = labelsForLevel(makeProject(), "training");
    expect(subset.labeledFrames.length).toBe(1);
    expect(subset.labeledFrames[0].frameIdx).toBe(0);
    // Suggestion frames for the video come along (for embed:"user+suggestions").
    expect(subset.suggestions.length).toBe(2);
  });

  it("full: keeps every labeled frame, including predicted-only", () => {
    const subset = labelsForLevel(makeProject(), "full");
    expect(subset.labeledFrames.length).toBe(3);
  });

  it("does not mutate the source labels (copy:false shares videos safely)", () => {
    const labels = makeProject();
    const beforeFrames = labels.labeledFrames.length;
    const beforeVideo = labels.videos[0];
    labelsForLevel(labels, "user");
    expect(labels.labeledFrames.length).toBe(beforeFrames);
    expect(labels.videos[0]).toBe(beforeVideo); // same live-backed Video object
  });

  it("round-trip: exported user package contains only user frames", async () => {
    const bytes = await saveSlpToBytes(labelsForLevel(makeProject(), "user"), {
      embed: embedModeForLevel("user"),
    });
    const reloaded = await loadSlp(toArrayBuffer(bytes), { openVideos: false });
    // The written package has ONE frame row, not the 3 labeled frames — the bug
    // was that all 3 (incl. 2 predicted-only) were written regardless of level.
    expect(reloaded.labeledFrames.length).toBe(1);
    expect(countUserFrames(reloaded)).toBe(1);
  });

  it("round-trip: exported full package contains all labeled frames", async () => {
    const bytes = await saveSlpToBytes(labelsForLevel(makeProject(), "full"), {
      embed: embedModeForLevel("full"),
    });
    const reloaded = await loadSlp(toArrayBuffer(bytes), { openVideos: false });
    expect(reloaded.labeledFrames.length).toBe(3);
  });
});

describe("Export Labels Package — embed-warning accuracy (result-based)", () => {
  function makeContinuousLabels(getFrame: () => unknown): Labels {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const backend = {
      filename: "clip.mp4",
      shape: [1, 1, 1, 3] as [number, number, number, number],
      async getFrame() {
        return getFrame();
      },
    };
    const video = new Video({
      filename: "clip.mp4",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      backend: backend as any,
      backendMetadata: { shape: [1, 1, 1, 3] },
      embedded: false, // continuous source → at risk, forces the reload check
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [0, 0];
    inst.points[0].visible = true;
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 0, instances: [inst] })
    );
    return labels;
  }

  it("does NOT warn when the export actually embedded (encoded-bytes source)", async () => {
    // A backend that yields encoded PNG bytes DOES embed on any io — the warning
    // must stay silent (this is the false-positive the fix removes).
    const labels = makeContinuousLabels(() => PNG_1x1);
    const bytes = await saveSlpToBytes(labels, { embed: "user" });
    expect(await packageLeavesFramesUnembedded(labels, bytes)).toBe(false);
  });

  it("DOES warn when the export embedded nothing (no readable backend)", async () => {
    // minimal_instance.slp references an external mp4 with no open backend, so
    // nothing embeds — the warning is correct here.
    const labels = await loadSlp(loadFixtureBytes("minimal_instance.slp"), {
      openVideos: false,
    });
    const bytes = await saveSlpToBytes(labels, { embed: "user" });
    expect(await packageLeavesFramesUnembedded(labels, bytes)).toBe(true);
  });

  it("short-circuits (no reload) when the source is already fully embedded", async () => {
    // Every source video already has embedded images → nothing at risk. Passing
    // empty bytes proves no reload happens (a reload would throw on empty input).
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = new Video({
      filename: "x.pkg.slp",
      backendMetadata: { shape: [1, 1, 1, 1] },
      openBackend: false,
      embedded: true,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    expect(video.hasEmbeddedImages).toBe(true);
    expect(await packageLeavesFramesUnembedded(labels, new Uint8Array())).toBe(
      false
    );
  });
});

describe("Export Labels Package — io round-trip", () => {
  it("mp4-backed FIXTURE: labels survive but NO images embedded (io gap)", async () => {
    // minimal_instance.slp references an external mp4 (non-embedded source).
    const labels = await loadSlp(loadFixtureBytes("minimal_instance.slp"), {
      openVideos: false,
    });
    const userFrames = countUserFrames(labels);
    expect(userFrames).toBeGreaterThan(0);

    const bytes = await saveSlpToBytes(labels, {
      embed: embedModeForLevel("user"),
    });
    const reloaded = await loadSlp(toArrayBuffer(bytes), {
      openVideos: false,
    });

    // Frames (labels) survive the round-trip.
    expect(countUserFrames(reloaded)).toBe(userFrames);
    // But the continuous/mp4 source embeds NO images — the package still
    // references the source video. This documents the io gap.
    expect(reloaded.videos[0].hasEmbeddedImages).toBe(false);
  });

  it("mp4 backend returning a DECODED frame embeds NO images (ImageBitmap dropped)", async () => {
    // Faithful model of the browser mp4 path: getFrame() returns a decoded
    // frame (ImageBitmap / ImageData-like), which io's frameToBytes() rejects.
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const backend = {
      filename: "clip.mp4",
      shape: [1, 1, 1, 3] as [number, number, number, number],
      async getFrame() {
        return { data: new Uint8Array([255, 0, 0]), width: 1, height: 1 };
      },
    };
    const video = new Video({
      filename: "clip.mp4",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      backend: backend as any,
      backendMetadata: { shape: [1, 1, 1, 3] },
      embedded: false,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [0, 0];
    inst.points[0].visible = true;
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 0, instances: [inst] })
    );

    const bytes = await saveSlpToBytes(labels, { embed: "user" });
    const reloaded = await loadSlp(toArrayBuffer(bytes), {
      openVideos: false,
    });
    expect(reloaded.labeledFrames.length).toBe(1);
    expect(reloaded.videos[0].hasEmbeddedImages).toBe(false);
  });

  it("encoded-bytes source (models embedded pkg.slp): images round-trip byte-exact", async () => {
    // A backend whose getFrame() returns ENCODED PNG bytes — exactly what an
    // already-embedded pkg.slp yields. This IS embedded and round-trips.
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const backend = {
      filename: "clip.mp4",
      shape: [1, 1, 1, 3] as [number, number, number, number],
      async getFrame() {
        return PNG_1x1;
      },
    };
    const video = new Video({
      filename: "clip.mp4",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      backend: backend as any,
      backendMetadata: { shape: [1, 1, 1, 3] },
      embedded: false,
    });
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [0, 0];
    inst.points[0].visible = true;
    labels.labeledFrames.push(
      new LabeledFrame({ video, frameIdx: 0, instances: [inst] })
    );

    const bytes = await saveSlpToBytes(labels, { embed: "user" });

    // Reload from a real temp file so the embedded backend can reopen and read
    // the stored blob back (a plain ArrayBuffer reload can't reopen by name).
    const tmp = path.join(os.tmpdir(), `pkg-roundtrip-${Date.now()}.pkg.slp`);
    fs.writeFileSync(tmp, bytes);
    try {
      const reloaded = await loadSlp(tmp, { openVideos: true });
      const v = reloaded.videos[0];
      expect(reloaded.labeledFrames.length).toBe(1);
      expect(v.hasEmbeddedImages).toBe(true);
      expect(v.embeddedFrameIndices).toEqual([0]);
      const stored = await v.getFrameBuffer(0);
      expect(stored).not.toBeNull();
      expect(Array.from(stored!)).toEqual(Array.from(PNG_1x1));
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
