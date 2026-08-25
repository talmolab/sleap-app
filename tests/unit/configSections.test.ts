import { describe, it, expect } from "../bun-test";
import { TRAINING_SECTIONS } from "@/lib/configSections";
import { defaultHyperparams } from "@/stores/trainingStore";

const ALL_FIELDS = Object.keys(defaultHyperparams) as (keyof typeof defaultHyperparams)[];

describe("TRAINING_SECTIONS taxonomy", () => {
  const assigned = TRAINING_SECTIONS.flatMap((s) => s.fields);

  it("assigns every hyperparameter to some section (nothing orphaned)", () => {
    const missing = ALL_FIELDS.filter((f) => !assigned.includes(f));
    expect(missing).toEqual([]);
  });

  it("assigns each hyperparameter to exactly one section (no duplicates)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const f of assigned) {
      if (seen.has(f)) dupes.push(f);
      seen.add(f);
    }
    expect(dupes).toEqual([]);
  });

  it("lists no unknown fields (every section field is a real hyperparameter)", () => {
    const unknown = assigned.filter((f) => !(f in defaultHyperparams));
    expect(unknown).toEqual([]);
  });

  it("gives every section a stable id and a human label", () => {
    const ids = new Set<string>();
    for (const s of TRAINING_SECTIONS) {
      expect(s.id).toMatch(/^[a-z-]+$/);
      expect(s.label.length).toBeGreaterThan(0);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
  });
});
