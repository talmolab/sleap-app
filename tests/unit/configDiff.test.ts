import { describe, it, expect } from "../bun-test";
import { computeConfigDiff } from "@/lib/configDiff";
import { defaultHyperparams } from "@/stores/trainingStore";

// Minimal section→field mapping, mirroring how the config shell groups fields.
const SECTIONS = [
  { id: "optimization", fields: ["learningRate", "maxEpochs", "batchSize"] as const },
  { id: "augmentation", fields: ["scaleEnabled", "scaleMin", "rotationPreset"] as const },
];

describe("computeConfigDiff", () => {
  it("reports no changes when current equals baseline", () => {
    const diff = computeConfigDiff(defaultHyperparams, defaultHyperparams, SECTIONS);
    expect(diff.totalChanged).toBe(0);
    expect(diff.changedFields.size).toBe(0);
    expect(diff.countBySection.optimization).toBe(0);
    expect(diff.countBySection.augmentation).toBe(0);
  });

  it("counts a single changed field within its section", () => {
    const current = { ...defaultHyperparams, learningRate: 0.001 };
    const diff = computeConfigDiff(current, defaultHyperparams, SECTIONS);
    expect(diff.totalChanged).toBe(1);
    expect(diff.changedFields.has("learningRate")).toBe(true);
    expect(diff.countBySection.optimization).toBe(1);
    expect(diff.countBySection.augmentation).toBe(0);
  });

  it("counts changes spread across multiple sections", () => {
    const current = {
      ...defaultHyperparams,
      maxEpochs: 200,
      batchSize: 8,
      scaleEnabled: true,
    };
    const diff = computeConfigDiff(current, defaultHyperparams, SECTIONS);
    expect(diff.totalChanged).toBe(3);
    expect(diff.countBySection.optimization).toBe(2);
    expect(diff.countBySection.augmentation).toBe(1);
  });

  it("treats a null→number change as modified (e.g. cropSize)", () => {
    const S = [{ id: "data", fields: ["cropSize"] as const }];
    const current = { ...defaultHyperparams, cropSize: 256 };
    const diff = computeConfigDiff(current, defaultHyperparams, S);
    expect(diff.totalChanged).toBe(1);
    expect(diff.changedFields.has("cropSize")).toBe(true);
    expect(diff.countBySection.data).toBe(1);
  });

  it("ignores changed fields that no section lists", () => {
    const current = { ...defaultHyperparams, wandbApiKey: "secret" };
    const diff = computeConfigDiff(current, defaultHyperparams, SECTIONS);
    expect(diff.totalChanged).toBe(0);
    expect(diff.changedFields.has("wandbApiKey" as keyof typeof current)).toBe(false);
  });
});
