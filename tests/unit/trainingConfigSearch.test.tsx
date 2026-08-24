/**
 * Tests for the Training Configuration dialog's parameter search.
 *
 * These lock in the fix for the search bar that previously filtered a static
 * `SEARCHABLE_FIELDS` list which had drifted from the rendered JSX (unfindable
 * fields, label mismatches, dangling scroll-target ids, and head results that
 * always routed to the first head tab). The search index is now the single
 * source of truth that also drives the field ids/labels, and these tests
 * enforce — in both directions — that it stays in sync with the real DOM.
 */

import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { defaultHyperparams, getConfigSlots, type ConfigFile, type ModelType } from "@/stores/trainingStore";

// `vi.mock` (bun `mock.module`) is NOT hoisted, so register mocks before the
// dialog module is dynamically imported below. ModelStatsPreview paints to a
// 2D canvas context that happy-dom does not implement.
import { vi } from "../bun-test";
vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/dialogs/ModelStatsPreview", () => ({ ModelStatsPreview: () => null }));

type DialogModule = typeof import("@/components/dialogs/TrainingConfigDialog");
let mod: DialogModule;
async function load(): Promise<DialogModule> {
  mod ??= await import("@/components/dialogs/TrainingConfigDialog");
  return mod;
}

function makeConfigs(modelType: ModelType): ConfigFile[] {
  return getConfigSlots(modelType).map((slot) => ({
    filename: `${slot}.yaml`,
    content: "",
    modelType: slot,
    slot,
    hyperparams: { ...defaultHyperparams },
    hasTrainedModel: false,
    checkpointPath: null,
  }));
}

function noop() {}

/** Radix Tabs need a pointer-down sequence; a plain click is a no-op in happy-dom. */
function switchToTab(index: number) {
  const tab = screen.getAllByRole("tab")[index];
  fireEvent.pointerDown(tab, { button: 0 });
  fireEvent.mouseDown(tab, { button: 0 });
}

function renderDialog(modelType: ModelType) {
  const { TrainingConfigDialog } = mod;
  return render(
    <TrainingConfigDialog
      open
      onClose={noop}
      modelType={modelType}
      configs={makeConfigs(modelType)}
      onUpdateSlot={noop}
      inferenceTarget="nothing"
      onInferenceTargetChange={noop}
      remoteEnabled={false}
      onRemoteEnabledChange={noop}
      skeletonNodes={["head", "thorax", "abdomen"]}
      sampleCount={20}
      onSampleCountChange={noop}
      skipUserLabeled={false}
      onSkipUserLabeledChange={noop}
      existingPredictions="clear_all"
      onExistingPredictionsChange={noop}
      autoOpenWandb={false}
      onAutoOpenWandbChange={noop}
    />
  );
}

beforeAll(async () => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS === "undefined") g.CSS = { escape: (s) => s };
  else if (!g.CSS.escape) g.CSS.escape = (s) => s;
  await load();
});

afterEach(() => cleanup());

describe("TrainingConfigDialog search index (pure)", () => {
  it("every entry has a non-empty id and label", () => {
    const { SEARCHABLE_FIELDS } = mod;
    expect(SEARCHABLE_FIELDS.length).toBeGreaterThan(40);
    for (const f of SEARCHABLE_FIELDS) {
      expect(f.id).toBeTruthy();
      expect(f.label).toBeTruthy();
      expect(f.tab === "pipeline" || f.tab === "head").toBe(true);
    }
  });

  it("has no duplicate ids within a tab", () => {
    const { SEARCHABLE_FIELDS } = mod;
    for (const tab of ["pipeline", "head"] as const) {
      const ids = SEARCHABLE_FIELDS.filter((f) => f.tab === tab).map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("dropped the old dangling scroll-target ids", () => {
    const { SEARCHABLE_FIELDS } = mod;
    const ids = new Set(SEARCHABLE_FIELDS.map((f) => f.id));
    // These ids never existed in the DOM (search silently scrolled nowhere).
    expect(ids.has("field-valfraction")).toBe(false);
    expect(ids.has("field-inputscale")).toBe(false);
  });

  it("matches on label, hint, and keyword synonyms (case-insensitive)", () => {
    const { SEARCHABLE_FIELDS, fieldMatchesQuery } = mod;
    const findable = (q: string) => SEARCHABLE_FIELDS.filter((f) => fieldMatchesQuery(f, q));

    // Every previously-broken query from the bug report now surfaces a field.
    for (const q of [
      "wandb", // section label was "W&B" in the old index, on-screen "WandB"
      "convert colors", // on-screen label the old index called "Ensure Channels"
      "epochs", // on-screen "Epochs", old index "Max Epochs"
      "learning rate",
      "validation fraction",
      "input scaling",
      "dataloader", // ~20 rendered fields were absent from the old index
      "number of devices",
      "plateau",
      "backbone",
      "loss weight",
      "wandb entity",
      "wandb project",
      "cuda", // keyword-only synonym (label is "Accelerator")
      "ohkm", // keyword-only synonym for the hard-keypoint-mining fields
    ]) {
      expect(findable(q).length).toBeGreaterThan(0);
    }

    // Non-matching query returns nothing (matcher isn't a no-op passthrough).
    expect(findable("zzz-not-a-parameter")).toHaveLength(0);
    // Empty query returns nothing.
    expect(fieldMatchesQuery(SEARCHABLE_FIELDS[0], "  ")).toBe(false);
  });
});

describe("TrainingConfigDialog search index ↔ DOM consistency", () => {
  it("pipeline: every indexed field resolves to a real DOM target", () => {
    renderDialog("top_down");
    const pipeline = mod.SEARCHABLE_FIELDS.filter((f) => f.tab === "pipeline");
    // top_down + populated configs render every pipeline field (incl. the
    // top-down-only anchor/sigma rows).
    for (const f of pipeline) {
      const el = document.getElementById(f.id);
      expect(el, `pipeline field "${f.label}" (#${f.id}) should exist in the DOM`).toBeTruthy();
      // The on-screen label must actually appear in its scroll target — this
      // catches label drift between the index and the rendered field.
      expect(el?.textContent?.toLowerCase()).toContain(f.label.toLowerCase());
    }
  });

  it("pipeline: every searchable DOM row is present in the index (no orphans)", () => {
    renderDialog("top_down");
    const indexIds = new Set(mod.SEARCHABLE_FIELDS.filter((f) => f.tab === "pipeline").map((f) => f.id));
    const domIds = Array.from(document.querySelectorAll<HTMLElement>("[data-search-field]"))
      .map((el) => el.id)
      .filter(Boolean);
    expect(domIds.length).toBeGreaterThan(0);
    for (const id of domIds) {
      expect(indexIds.has(id), `DOM row #${id} is searchable but missing from the index`).toBe(true);
    }
  });

  it("head: every non-conditional indexed field resolves in a head tab", async () => {
    renderDialog("top_down");
    // Switch to the centered_instance head tab (2nd head slot).
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const headFields = mod.SEARCHABLE_FIELDS.filter((f) => f.tab === "head" && !f.conditional);
    for (const f of headFields) {
      const el = document.getElementById(f.id);
      expect(el, `head field "${f.label}" (#${f.id}) should exist in the DOM`).toBeTruthy();
      expect(el?.textContent?.toLowerCase()).toContain(f.label.toLowerCase());
    }
    // Conditional rows that DO render for centered_instance.
    expect(document.getElementById("field-cropsize")).toBeTruthy();
  });

  it("head: every searchable DOM row is present in the index (no orphans)", async () => {
    renderDialog("top_down");
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const indexIds = new Set(mod.SEARCHABLE_FIELDS.filter((f) => f.tab === "head").map((f) => f.id));
    const domIds = Array.from(document.querySelectorAll<HTMLElement>("[data-search-field]"))
      .map((el) => el.id)
      .filter(Boolean);
    for (const id of domIds) {
      expect(indexIds.has(id), `DOM row #${id} is searchable but missing from the head index`).toBe(true);
    }
  });
});

describe("TrainingConfigDialog search navigation", () => {
  /** Click the search dropdown result whose button text includes `label`. */
  function clickResult(label: string) {
    const btn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes(label) && /Training Pipeline|Per-Head/.test(b.textContent ?? ""));
    expect(btn, `search result for "${label}" should be in the dropdown`).toBeTruthy();
    fireEvent.click(btn!);
  }

  it("a head-field result from the pipeline tab jumps to the first head tab", async () => {
    renderDialog("top_down");
    // Start on the pipeline tab (default). "Batch Size" is a head field.
    const input = screen.getByPlaceholderText("Search parameters...");
    fireEvent.change(input, { target: { value: "Batch Size" } });
    clickResult("Batch Size");
    // The first head tab (centroid) mounts, so head content is now in the DOM.
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true"); // centroid
    expect(tabs[0].getAttribute("aria-selected")).toBe("false"); // pipeline
  });

  it("a head-field result stays on the head tab the user is already viewing", async () => {
    renderDialog("top_down");
    // Move to the SECOND head tab (centered_instance) first.
    switchToTab(2);
    await waitFor(() => expect(document.getElementById("head-data")).toBeTruthy());

    const input = screen.getByPlaceholderText("Search parameters...");
    fireEvent.change(input, { target: { value: "Batch Size" } });
    clickResult("Batch Size");

    // Must NOT snap back to the first head tab (the old always-first bug).
    const tabs = screen.getAllByRole("tab");
    expect(tabs[2].getAttribute("aria-selected")).toBe("true"); // centered_instance
    expect(tabs[1].getAttribute("aria-selected")).toBe("false"); // centroid
  });
});
