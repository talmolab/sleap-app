/**
 * Tests for skeleton template data validation.
 */

import { describe, it, expect } from "../bun-test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SKELETON_TEMPLATES,
  TEMPLATE_ORDER,
} from "@/lib/skeletonTemplates";

describe("skeletonTemplates", () => {
  it("TEMPLATE_ORDER matches SKELETON_TEMPLATES keys", () => {
    for (const id of TEMPLATE_ORDER) {
      expect(SKELETON_TEMPLATES[id]).toBeDefined();
    }
  });

  it("all templates have valid structure", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      expect(template.name).toBeDefined();
      expect(typeof template.name).toBe("string");
      expect(template.name.length).toBeGreaterThan(0);

      expect(template.description).toBeDefined();
      expect(typeof template.description).toBe("string");

      expect(Array.isArray(template.nodes)).toBe(true);
      expect(Array.isArray(template.edges)).toBe(true);
    }
  });

  it("edge indices are within node bounds", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      for (const [srcIdx, dstIdx] of template.edges) {
        expect(srcIdx).toBeGreaterThanOrEqual(0);
        expect(srcIdx).toBeLessThan(template.nodes.length);
        expect(dstIdx).toBeGreaterThanOrEqual(0);
        expect(dstIdx).toBeLessThan(template.nodes.length);
      }
    }
  });

  it("offers legacy SLEAP's templates, then the human one, each with an image, then a blank one", () => {
    expect([...TEMPLATE_ORDER]).toEqual([
      "bees",
      "flies13",
      "fly32",
      "gerbils",
      "mice_hc",
      "mice_of",
      "human_coco",
      "custom",
    ]);
    for (const id of TEMPLATE_ORDER) {
      if (id !== "custom") expect(SKELETON_TEMPLATES[id].previewImage).toBeDefined();
    }
  });

  it("no two templates share a name", () => {
    const names = Object.values(SKELETON_TEMPLATES).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("offers one 32-node fly: legacy SLEAP's, with its example", () => {
    const flies = Object.values(SKELETON_TEMPLATES).filter((t) => t.nodes.length === 32);
    expect(flies).toHaveLength(1);
    expect(flies[0]).toBe(SKELETON_TEMPLATES.fly32);
    expect(flies[0].name).toBe("Fly (32 nodes)");
    expect(flies[0].previewImage).toBe("fly32.png");
  });

  it("no duplicate node names within a template", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      const names = new Set(template.nodes);
      expect(names.size).toBe(template.nodes.length);
    }
  });

  describe("specific templates", () => {
    it("custom template has 0 nodes", () => {
      expect(SKELETON_TEMPLATES.custom.nodes.length).toBe(0);
      expect(SKELETON_TEMPLATES.custom.edges.length).toBe(0);
    });

    it("human template is COCO's 17 keypoints and 19 limbs, in COCO's order", () => {
      const human = SKELETON_TEMPLATES.human_coco;
      expect(human.nodes).toEqual([
        "nose", "left_eye", "right_eye", "left_ear", "right_ear",
        "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
        "left_wrist", "right_wrist", "left_hip", "right_hip",
        "left_knee", "right_knee", "left_ankle", "right_ankle",
      ]);
      // COCO's skeleton, 1-indexed as in its annotation files. Same limbs,
      // regardless of the direction each edge points.
      const coco = [
        [16, 14], [14, 12], [17, 15], [15, 13], [12, 13], [6, 12], [7, 13],
        [6, 7], [6, 8], [7, 9], [8, 10], [9, 11], [2, 3], [1, 2], [1, 3],
        [2, 4], [3, 5], [4, 6], [5, 7],
      ];
      const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
      expect(new Set(human.edges.map(([a, b]) => key(a, b)))).toEqual(
        new Set(coco.map(([a, b]) => key(a - 1, b - 1)))
      );
      expect(human.edges).toHaveLength(19);
      // Every left/right pair, and each pairs a left_ node with its right_ twin.
      expect(human.symmetries).toHaveLength(8);
      for (const [l, r] of human.symmetries!) {
        expect(human.nodes[r]).toBe(human.nodes[l].replace("left_", "right_"));
      }
    });
  });

  it("edges are valid index pairs", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      for (const edge of template.edges) {
        expect(Array.isArray(edge)).toBe(true);
        expect(edge.length).toBe(2);
        expect(typeof edge[0]).toBe("number");
        expect(typeof edge[1]).toBe("number");
      }
    }
  });

  it("no self-edges (source equals destination)", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      for (const [srcIdx, dstIdx] of template.edges) {
        expect(srcIdx).not.toBe(dstIdx);
      }
    }
  });

  describe("legacy SLEAP reference templates", () => {
    const expected: Record<string, number> = {
      bees: 21,
      flies13: 13,
      fly32: 32,
      gerbils: 14,
      mice_hc: 5,
      mice_of: 11,
    };

    it("includes each template legacy SLEAP shipped, with its node count", () => {
      for (const [id, count] of Object.entries(expected)) {
        expect(TEMPLATE_ORDER as readonly string[]).toContain(id);
        expect(SKELETON_TEMPLATES[id].nodes).toHaveLength(count);
      }
    });

    it("keeps the left/right symmetries legacy defined", () => {
      expect(SKELETON_TEMPLATES.flies13.symmetries).toHaveLength(5);
      expect(SKELETON_TEMPLATES.gerbils.symmetries).toHaveLength(2);
    });
  });

  it("symmetry indices are within node bounds and pair two different nodes", () => {
    for (const template of Object.values(SKELETON_TEMPLATES)) {
      for (const [a, b] of template.symmetries ?? []) {
        expect(a).not.toBe(b);
        for (const i of [a, b]) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(template.nodes.length);
        }
      }
    }
  });

  it("every preview image a template names is in public/skeleton-templates", () => {
    const dir = join(import.meta.dir, "../../public/skeleton-templates");
    const named = Object.values(SKELETON_TEMPLATES).filter((t) => t.previewImage);
    expect(named.length).toBe(7);
    for (const t of named) {
      expect(existsSync(join(dir, t.previewImage!))).toBe(true);
    }
  });

  it("every reference-dataset template has its example figure and a description", () => {
    const dir = join(import.meta.dir, "../../public/skeleton-templates");
    const withDataset = Object.values(SKELETON_TEMPLATES).filter((t) => t.dataset);
    // The six legacy SLEAP reference-dataset templates; the human one has a
    // preview but no reference dataset.
    expect(withDataset.map((t) => t.name)).toEqual(
      Object.values(SKELETON_TEMPLATES)
        .filter((t) => t.previewImage && t !== SKELETON_TEMPLATES.human_coco)
        .map((t) => t.name)
    );
    for (const t of withDataset) {
      expect(existsSync(join(dir, t.dataset!.exampleImage))).toBe(true);
      expect(t.dataset!.description.length).toBeGreaterThan(0);
    }
  });
});
