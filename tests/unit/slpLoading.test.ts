/**
 * Tests for SLP file loading.
 *
 * These tests verify that SLP files from the test fixtures can be loaded
 * using @talmolab/sleap-io.js.
 *
 * These run with a happy-dom DOM registered: the `../bun-test` shim registers
 * it globally and bun test has no per-file environment, so a `document` is
 * present even though these tests don't exercise it. Fixtures are read into an
 * ArrayBuffer and passed to loadSlp, so the node-fs file path isn't required.
 */

import { describe, it, expect } from "../bun-test";
import { loadSlp } from "@talmolab/sleap-io.js";
import fs from "fs";
import path from "path";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

/** Load an SLP file from the fixtures directory. */
async function loadFixture(filename: string) {
  const filePath = path.join(FIXTURES_DIR, filename);
  const buffer = fs.readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  // openVideos: false avoids MediaVideoBackend which requires browser APIs
  return loadSlp(arrayBuffer, { openVideos: false });
}

describe("SLP file loading", () => {
  describe("centered_pair.slp", () => {
    it("loads successfully", async () => {
      const labels = await loadFixture("centered_pair.slp");
      expect(labels).toBeDefined();
    });

    it("has videos", async () => {
      const labels = await loadFixture("centered_pair.slp");
      expect(labels.videos.length).toBeGreaterThan(0);
    });

    it("has skeletons", async () => {
      const labels = await loadFixture("centered_pair.slp");
      expect(labels.skeletons.length).toBeGreaterThan(0);
    });

    it("has labeled frames", async () => {
      const labels = await loadFixture("centered_pair.slp");
      expect(labels.labeledFrames.length).toBeGreaterThan(0);
    });

    it("has skeleton with nodes", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      expect(skeleton.nodes.length).toBeGreaterThan(0);
    });

    it("has skeleton with edges", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      expect(skeleton.edges.length).toBeGreaterThan(0);
    });

    it("has instances on labeled frames", async () => {
      const labels = await loadFixture("centered_pair.slp");
      // At least one labeled frame should have instances
      const hasInstances = labels.labeledFrames.some(
        (lf) => lf.instances.length > 0
      );
      expect(hasInstances).toBe(true);
    });

    it("has specific skeleton node count", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      // centered_pair has a multi-node skeleton
      expect(skeleton.nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("has specific skeleton edge count", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      expect(skeleton.edges.length).toBeGreaterThanOrEqual(1);
    });

    it("skeleton nodes have names", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      for (const node of skeleton.nodes) {
        expect(node.name).toBeDefined();
        expect(typeof node.name).toBe("string");
        expect(node.name.length).toBeGreaterThan(0);
      }
    });

    it("instances have points matching skeleton node count", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const skeleton = labels.skeletons[0];
      const lf = labels.labeledFrames.find(
        (f) => f.instances.length > 0
      );
      expect(lf).toBeDefined();
      if (lf) {
        for (const inst of lf.instances) {
          expect(inst.points.length).toBe(skeleton.nodes.length);
        }
      }
    });

    it("instances have point coordinates as numbers", async () => {
      const labels = await loadFixture("centered_pair.slp");
      const lf = labels.labeledFrames.find(
        (f) => f.instances.length > 0
      );
      expect(lf).toBeDefined();
      if (lf) {
        const inst = lf.instances[0];
        for (const pt of inst.points) {
          expect(pt.xy).toBeDefined();
          expect(pt.xy.length).toBe(2);
          expect(typeof pt.xy[0]).toBe("number");
          expect(typeof pt.xy[1]).toBe("number");
        }
      }
    });

    it("has exactly 1 video", async () => {
      const labels = await loadFixture("centered_pair.slp");
      expect(labels.videos.length).toBe(1);
    });
  });

  describe("minimal_instance.slp", () => {
    it("loads successfully", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      expect(labels).toBeDefined();
    });

    it("has expected structure", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      expect(labels.videos.length).toBeGreaterThan(0);
      expect(labels.skeletons.length).toBeGreaterThan(0);
    });

    it("has labeled frames with instances", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      expect(labels.labeledFrames.length).toBeGreaterThan(0);
      const hasInstances = labels.labeledFrames.some(
        (lf) => lf.instances.length > 0
      );
      expect(hasInstances).toBe(true);
    });

    it("skeleton has at least one node", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      expect(labels.skeletons[0].nodes.length).toBeGreaterThanOrEqual(1);
    });

    it("instances have valid point data", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      const lf = labels.labeledFrames.find(
        (f) => f.instances.length > 0
      );
      expect(lf).toBeDefined();
      if (lf) {
        for (const inst of lf.instances) {
          expect(inst.points.length).toBe(labels.skeletons[0].nodes.length);
          for (const pt of inst.points) {
            expect(pt.xy).toBeDefined();
            expect(pt.xy.length).toBe(2);
          }
        }
      }
    });

    it("has frame indices as non-negative numbers", async () => {
      const labels = await loadFixture("minimal_instance.slp");
      for (const lf of labels.labeledFrames) {
        expect(lf.frameIdx).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(lf.frameIdx)).toBe(true);
      }
    });
  });

  describe("small_robot_minimal.slp", () => {
    it("loads successfully", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      expect(labels).toBeDefined();
    });

    it("has expected structure", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      expect(labels.videos.length).toBeGreaterThan(0);
      expect(labels.skeletons.length).toBeGreaterThan(0);
    });

    it("has labeled frames", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      expect(labels.labeledFrames.length).toBeGreaterThan(0);
    });

    it("skeleton nodes have names", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      const skeleton = labels.skeletons[0];
      for (const node of skeleton.nodes) {
        expect(node.name).toBeDefined();
        expect(typeof node.name).toBe("string");
      }
    });

    it("videos have filenames", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      for (const video of labels.videos) {
        expect(video.filename).toBeDefined();
        expect(typeof video.filename).toBe("string");
      }
    });

    it("labeled frames reference the video", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      for (const lf of labels.labeledFrames) {
        expect(lf.video).toBeDefined();
        expect(labels.videos).toContain(lf.video);
      }
    });

    it("instances have skeleton references", async () => {
      const labels = await loadFixture("small_robot_minimal.slp");
      const lf = labels.labeledFrames.find(
        (f) => f.instances.length > 0
      );
      if (lf) {
        for (const inst of lf.instances) {
          expect(inst.skeleton).toBeDefined();
        }
      }
    });
  });

  describe("cross-fixture consistency", () => {
    it("all fixtures load without errors", async () => {
      const fixtures = ["centered_pair.slp", "minimal_instance.slp", "small_robot_minimal.slp"];
      for (const fixture of fixtures) {
        const labels = await loadFixture(fixture);
        expect(labels).toBeDefined();
        expect(labels.videos.length).toBeGreaterThan(0);
        expect(labels.skeletons.length).toBeGreaterThan(0);
      }
    });

    it("all fixtures have consistent instance-skeleton point counts", async () => {
      const fixtures = ["centered_pair.slp", "minimal_instance.slp", "small_robot_minimal.slp"];
      for (const fixture of fixtures) {
        const labels = await loadFixture(fixture);
        const skeleton = labels.skeletons[0];
        for (const lf of labels.labeledFrames) {
          for (const inst of lf.instances) {
            expect(inst.points.length).toBe(skeleton.nodes.length);
          }
        }
      }
    });
  });
});
