/**
 * Tests for export utility functions.
 */

import { describe, it, expect } from "../bun-test";
import { suggestSaveFilename } from "@/lib/exportUtils";

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
