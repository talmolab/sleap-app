import { describe, it, expect } from "../bun-test";
import { matchConfigSearch, TRAINING_SEARCH_INDEX, type SearchEntry } from "@/lib/configSearch";
import { TRAINING_SECTIONS } from "@/lib/configSections";

const IDX: SearchEntry[] = [
  { sectionId: "optimization", label: "Initial Learning Rate", keywords: "lr learning rate" },
  { sectionId: "optimization", label: "Epochs", keywords: "max epochs" },
  { sectionId: "optimization", label: "Hard/Easy Ratio", keywords: "ohkm mining ratio hard easy" },
  { sectionId: "wandb", label: "API Key", keywords: "wandb token auth" },
];

describe("matchConfigSearch", () => {
  it("returns nothing for an empty query", () => {
    expect(matchConfigSearch("", IDX)).toEqual([]);
    expect(matchConfigSearch("   ", IDX)).toEqual([]);
  });

  it("matches on the visible label (case-insensitive)", () => {
    const r = matchConfigSearch("learning", IDX);
    expect(r.map((e) => e.label)).toEqual(["Initial Learning Rate"]);
  });

  it("matches on keyword synonyms not shown in the label", () => {
    const r = matchConfigSearch("lr", IDX);
    expect(r.map((e) => e.label)).toContain("Initial Learning Rate");
    const ohkm = matchConfigSearch("ohkm", IDX);
    expect(ohkm.map((e) => e.label)).toContain("Hard/Easy Ratio");
  });

  it("requires ALL whitespace-separated tokens to match (AND)", () => {
    expect(matchConfigSearch("hard ratio", IDX).map((e) => e.label)).toEqual(["Hard/Easy Ratio"]);
    expect(matchConfigSearch("hard wandb", IDX)).toEqual([]);
  });
});

describe("TRAINING_SEARCH_INDEX", () => {
  it("only references real section ids", () => {
    const ids = new Set(TRAINING_SECTIONS.map((s) => s.id));
    const bad = TRAINING_SEARCH_INDEX.filter((e) => !ids.has(e.sectionId));
    expect(bad).toEqual([]);
  });

  it("covers common searches from the legacy keyword index", () => {
    for (const q of ["lr", "ohkm", "backbone", "crop", "offline", "gpu", "epochs"]) {
      expect(matchConfigSearch(q, TRAINING_SEARCH_INDEX).length).toBeGreaterThan(0);
    }
  });
});
