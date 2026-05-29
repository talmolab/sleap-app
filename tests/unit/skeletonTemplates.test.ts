/**
 * Tests for skeleton template data validation.
 */

import { describe, it, expect } from "../bun-test";
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

  it("no duplicate node names within a template", () => {
    for (const [, template] of Object.entries(SKELETON_TEMPLATES)) {
      const names = new Set(template.nodes);
      expect(names.size).toBe(template.nodes.length);
    }
  });

  describe("specific templates", () => {
    it("fly template has 32 nodes", () => {
      expect(SKELETON_TEMPLATES.fly.nodes.length).toBe(32);
    });

    it("human template has 17 nodes", () => {
      expect(SKELETON_TEMPLATES.human.nodes.length).toBe(17);
    });

    it("mouse_topdown template has 12 nodes", () => {
      expect(SKELETON_TEMPLATES.mouse_topdown.nodes.length).toBe(12);
    });

    it("celegans template has 2 nodes", () => {
      expect(SKELETON_TEMPLATES.celegans.nodes.length).toBe(2);
    });

    it("custom template has 0 nodes", () => {
      expect(SKELETON_TEMPLATES.custom.nodes.length).toBe(0);
      expect(SKELETON_TEMPLATES.custom.edges.length).toBe(0);
    });

    it("fly template starts with 'head'", () => {
      expect(SKELETON_TEMPLATES.fly.nodes[0]).toBe("head");
    });

    it("human template starts with 'nose'", () => {
      expect(SKELETON_TEMPLATES.human.nodes[0]).toBe("nose");
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
});
