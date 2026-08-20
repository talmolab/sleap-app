import { describe, it, expect, vi } from "../bun-test";
import { resolveSlotConfigSource } from "@/lib/trainedConfigAutoload";
import type { DiscoveredModel } from "@/lib/modelDiscovery";
import type { TrainedConfigFsAccess } from "@/lib/trainedConfigAutoload";
import type { ModelType } from "@/stores/trainingStore";

// The bun-test `vi.fn` shim widens the impl to `(...args: never[]) => unknown`
// (see bun-test.ts's `vi.mock` doc comment), which isn't structurally
// assignable to `TrainedConfigFsAccess`'s `Promise<string>`-returning methods
// — `overrides` is typed loosely and the whole result cast through `unknown`
// rather than fighting the shim's type at every call site.
function fakeFs(
  overrides: { join?: unknown; readTextFile?: unknown } = {},
): TrainedConfigFsAccess {
  return {
    join: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    readTextFile: vi.fn(async () => "trained: yaml"),
    ...overrides,
  } as unknown as TrainedConfigFsAccess;
}

function discoveredFor(
  headKey: string,
  path = "/proj/models/run1",
  checkpointFile: string | null = "best.ckpt",
): DiscoveredModel[] {
  return [{ path, headKey, runName: "run1", mtimeMs: 1000, checkpointFile }];
}

describe("resolveSlotConfigSource", () => {
  it("prefers a matching trained run's training_config.yaml over the baseline", async () => {
    const fs = fakeFs({ readTextFile: vi.fn(async () => "trained: yaml") });
    const result = await resolveSlotConfigSource(
      "centroid",
      "top_down",
      discoveredFor("centroid"),
      fs,
    );
    expect(result).toEqual({
      yamlText: "trained: yaml",
      filename: "training_config.yaml",
      checkpointPath: "/proj/models/run1/best.ckpt",
    });
    expect(fs.join).toHaveBeenCalledWith("/proj/models/run1", "training_config.yaml");
    expect(fs.join).toHaveBeenCalledWith("/proj/models/run1", "best.ckpt");
  });

  it("returns a null checkpointPath when the trained match has no checkpointFile", async () => {
    const fs = fakeFs({ readTextFile: vi.fn(async () => "trained: yaml") });
    const result = await resolveSlotConfigSource(
      "centroid",
      "top_down",
      discoveredFor("centroid", "/proj/models/run1", null),
      fs,
    );
    expect(result?.checkpointPath).toBeNull();
  });

  it("falls back to the baseline when no discovered model matches the slot's head", async () => {
    const fs = fakeFs();
    const result = await resolveSlotConfigSource(
      "centroid",
      "top_down",
      discoveredFor("bottomup"), // wrong head — doesn't match "centroid"
      fs,
    );
    expect(result?.filename).not.toBe("training_config.yaml");
    expect(result?.yamlText.length).toBeGreaterThan(0);
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it("falls back to the baseline when discovered is empty (fresh project, no models/ dir)", async () => {
    const fs = fakeFs();
    const result = await resolveSlotConfigSource("centered_instance", "top_down", [], fs);
    expect(result?.filename).not.toBe("training_config.yaml");
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it("falls back to the baseline when the matched run's config file can't be read", async () => {
    const fs = fakeFs({
      readTextFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });
    const result = await resolveSlotConfigSource(
      "centroid",
      "top_down",
      discoveredFor("centroid"),
      fs,
    );
    expect(result?.filename).not.toBe("training_config.yaml");
    expect(result?.yamlText.length).toBeGreaterThan(0);
  });

  it("returns null when there's neither a trained match nor a baseline for the head", async () => {
    const fs = fakeFs();
    const result = await resolveSlotConfigSource(
      "config",
      "unknown_pipeline" as ModelType,
      [],
      fs,
    );
    expect(result).toBeNull();
  });

  describe("preferTrained: false (tutorial's first training pass)", () => {
    it("uses the baseline even when a matching trained run exists", async () => {
      const fs = fakeFs();
      const result = await resolveSlotConfigSource(
        "centroid",
        "top_down",
        discoveredFor("centroid"),
        fs,
        { preferTrained: false },
      );
      expect(result?.filename).not.toBe("training_config.yaml");
      expect(fs.readTextFile).not.toHaveBeenCalled();
      expect(fs.join).not.toHaveBeenCalled();
    });

    it("defaults to preferTrained: true when opts is omitted", async () => {
      const fs = fakeFs();
      const result = await resolveSlotConfigSource(
        "centroid",
        "top_down",
        discoveredFor("centroid"),
        fs,
      );
      expect(result?.filename).toBe("training_config.yaml");
    });
  });
});
