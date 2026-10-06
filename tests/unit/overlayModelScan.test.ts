import { describe, it, expect } from "../bun-test";
import {
  dirName,
  baseName,
  joinPath,
  overlayScanRoots,
  scanModelCatalog,
  classifyModelDir,
  type ScanFs,
} from "@/lib/models/overlayModelScan";

/** training_config.yaml text with `active` as the one non-null head. */
function cfg(active: string): string {
  const heads = ["single_instance", "centroid", "centered_instance", "bottomup"];
  const body = heads
    .map((h) => (h === active ? `    ${h}:\n      confmaps:\n        sigma: 2.5` : `    ${h}: null`))
    .join("\n");
  return `model_config:\n  head_configs:\n${body}`;
}

/**
 * In-memory ScanFs from a path→node map. A directory node has `dir` (child
 * names); a file node has `text` (or "" to merely exist).
 */
function fakeFs(tree: Record<string, { dir?: string[]; text?: string }>): ScanFs {
  return {
    async readDir(p) {
      const node = tree[p];
      if (!node?.dir) throw new Error(`ENOENT ${p}`);
      return node.dir.map((name) => ({
        name,
        isDirectory: !!tree[joinPath(p, name)]?.dir,
      }));
    },
    async readTextFile(p) {
      const node = tree[p];
      if (node?.text == null) throw new Error(`ENOENT ${p}`);
      return node.text;
    },
    async exists(p) {
      return p in tree;
    },
  };
}

describe("path helpers", () => {
  it("dirName strips the last POSIX segment", () => {
    expect(dirName("/a/b/proj.slp")).toBe("/a/b");
  });
  it("dirName strips the last Windows segment", () => {
    expect(dirName("C:\\x\\y\\proj.slp")).toBe("C:\\x\\y");
  });
  it("baseName returns the last segment (both separators)", () => {
    expect(baseName("/a/b/run.centroid")).toBe("run.centroid");
    expect(baseName("C:\\x\\run.centroid")).toBe("run.centroid");
  });
  it("joinPath uses the path's own separator", () => {
    expect(joinPath("/a/b", "models")).toBe("/a/b/models");
    expect(joinPath("C:\\x\\y", "models")).toBe("C:\\x\\y\\models");
  });
});

describe("overlayScanRoots", () => {
  it("returns [dir, dir/models] for a POSIX project path", () => {
    expect(overlayScanRoots("/data/proj.slp")).toEqual(["/data", "/data/models"]);
  });
  it("returns [] when there is no project path", () => {
    expect(overlayScanRoots(null)).toEqual([]);
  });
});

const TREE: Record<string, { dir?: string[]; text?: string }> = {
  "/proj/models": { dir: ["run_c", "run_ci", "run_untrained", "not_a_model", "readme.txt"] },
  "/proj/models/run_c": { dir: ["training_config.yaml", "best.ckpt"] },
  "/proj/models/run_c/training_config.yaml": { text: cfg("centroid") },
  "/proj/models/run_c/best.ckpt": { text: "" },
  "/proj/models/run_ci": { dir: ["training_config.yaml", "best.ckpt"] },
  "/proj/models/run_ci/training_config.yaml": { text: cfg("centered_instance") },
  "/proj/models/run_ci/best.ckpt": { text: "" },
  "/proj/models/run_untrained": { dir: ["training_config.yaml"] }, // no best.ckpt
  "/proj/models/run_untrained/training_config.yaml": { text: cfg("single_instance") },
  "/proj/models/not_a_model": { dir: ["notes.txt"] }, // no training_config.yaml
  "/proj/models/not_a_model/notes.txt": { text: "hi" },
  "/proj/models/readme.txt": { text: "hi" }, // a file, not a dir
};

describe("scanModelCatalog", () => {
  it("returns one entry per trained model dir, classified by head", async () => {
    const catalog = await scanModelCatalog(["/proj/models"], fakeFs(TREE));
    expect(catalog).toEqual([
      { path: "/proj/models/run_c", runName: "run_c", head: "centroid" },
      { path: "/proj/models/run_ci", runName: "run_ci", head: "centered_instance" },
    ]);
  });

  it("skips untrained dirs (no best.ckpt), non-model dirs, and plain files", async () => {
    const catalog = await scanModelCatalog(["/proj/models"], fakeFs(TREE));
    expect(catalog.map((e) => e.runName)).not.toContain("run_untrained");
    expect(catalog.map((e) => e.runName)).not.toContain("not_a_model");
    expect(catalog.map((e) => e.runName)).not.toContain("readme.txt");
  });

  it("dedupes models reachable from more than one root", async () => {
    const catalog = await scanModelCatalog(["/proj/models", "/proj/models"], fakeFs(TREE));
    expect(catalog).toHaveLength(2);
  });

  it("skips roots that don't exist without throwing", async () => {
    const catalog = await scanModelCatalog(["/nope", "/proj/models"], fakeFs(TREE));
    expect(catalog).toHaveLength(2);
  });
});

describe("classifyModelDir (Browse…)", () => {
  it("classifies a trained model dir", async () => {
    const r = await classifyModelDir("/proj/models/run_c", fakeFs(TREE));
    expect(r).toEqual({ path: "/proj/models/run_c", runName: "run_c", head: "centroid", trained: true });
  });
  it("reports an untrained dir (head known, trained false)", async () => {
    const r = await classifyModelDir("/proj/models/run_untrained", fakeFs(TREE));
    expect(r.head).toBe("single_instance");
    expect(r.trained).toBe(false);
  });
  it("reports a non-model dir (head null)", async () => {
    const r = await classifyModelDir("/proj/models/not_a_model", fakeFs(TREE));
    expect(r.head).toBeNull();
    expect(r.trained).toBe(false);
  });
});
