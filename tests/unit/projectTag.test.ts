import { describe, it, expect } from "../bun-test";
import { projectTag } from "@/lib/projectTag";

describe("projectTag", () => {
  it("uses the basename of a posix path", () => {
    expect(projectTag("/Users/amickl/projects/my-experiment.slp").name).toBe("my-experiment.slp");
  });

  it("uses the basename of a windows path", () => {
    expect(projectTag("C:\\Users\\amickl\\projects\\my-experiment.slp").name).toBe(
      "my-experiment.slp",
    );
  });

  it("falls back to 'untitled.slp' for an unsaved project (null path)", () => {
    expect(projectTag(null).name).toBe("untitled.slp");
  });

  it("id is 8 lowercase hex characters", () => {
    const { id } = projectTag("/Users/amickl/projects/my-experiment.slp");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic: the same path always yields the same id", () => {
    const a = projectTag("/Users/amickl/projects/my-experiment.slp");
    const b = projectTag("/Users/amickl/projects/my-experiment.slp");
    expect(a).toEqual(b);
  });

  it("different paths yield different ids", () => {
    const a = projectTag("/Users/amickl/projects/a.slp");
    const b = projectTag("/Users/amickl/projects/b.slp");
    expect(a.id).not.toBe(b.id);
  });

  it("every untitled (null) project tags the same way", () => {
    expect(projectTag(null)).toEqual(projectTag(null));
  });

  it("a null path and a literal empty-string path hash the same (no path to disambiguate by)", () => {
    expect(projectTag(null).id).toBe(projectTag("").id);
  });
});
