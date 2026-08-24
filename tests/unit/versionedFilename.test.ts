import { describe, it, expect } from "../bun-test";
import { getNewVersionFilename } from "@/lib/versionedFilename";

describe("getNewVersionFilename", () => {
  it("increments a .vNNN.slp version, keeping the pad width", () => {
    expect(getNewVersionFilename("labels.v001.slp")).toBe("labels.v002.slp");
    expect(getNewVersionFilename("labels.v009.slp")).toBe("labels.v010.slp");
    expect(getNewVersionFilename("labels.v099.slp")).toBe("labels.v100.slp");
  });

  it("seeds a new project from labels.v000.slp to labels.v001.slp", () => {
    expect(getNewVersionFilename("labels.v000.slp")).toBe("labels.v001.slp");
  });

  it("grows the width when the counter overflows the pad", () => {
    expect(getNewVersionFilename("labels.v999.slp")).toBe("labels.v1000.slp");
  });

  it("preserves a non-3-digit pad width", () => {
    expect(getNewVersionFilename("x.v1.slp")).toBe("x.v2.slp");
    expect(getNewVersionFilename("x.v05.slp")).toBe("x.v06.slp");
  });

  it("starts versioning an unversioned .slp at .v001 (add .v001)", () => {
    expect(getNewVersionFilename("experiment.slp")).toBe("experiment.v001.slp");
  });

  it("inserts the version before the final .slp for dotted stems", () => {
    expect(getNewVersionFilename("my.data.slp")).toBe("my.data.v001.slp");
  });

  it("preserves a directory prefix", () => {
    expect(getNewVersionFilename("/home/u/proj/labels.v002.slp")).toBe(
      "/home/u/proj/labels.v003.slp"
    );
    expect(getNewVersionFilename("/home/u/experiment.slp")).toBe(
      "/home/u/experiment.v001.slp"
    );
  });

  it("appends a versioned .slp to a name with no .slp extension", () => {
    expect(getNewVersionFilename("labels")).toBe("labels.v001.slp");
  });
});
