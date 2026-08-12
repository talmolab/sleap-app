import { describe, it, expect } from "../bun-test";
import { humanizeCommandName } from "@/lib/humanizeCommand";

describe("humanizeCommandName", () => {
  const cases: Array<[string, string]> = [
    ["MergeIntoProject", "Merge Into Project"],
    ["AddInstance", "Add Instance"],
    ["DeleteSelectedInstance", "Delete Selected Instance"],
    ["MergePredictions", "Merge Predictions"],
    ["SetInstanceTrack", "Set Instance Track"],
    ["AddInstancesFromAllPredictions", "Add Instances From All Predictions"],
    ["Undo", "Undo"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(humanizeCommandName(input)).toBe(expected);
    });
  }

  it("passes through a null-ish name safely", () => {
    expect(humanizeCommandName(null as unknown as string)).toBe("");
  });
});
