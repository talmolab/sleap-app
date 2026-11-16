/**
 * Plot click-to-seek vs. double-click-to-zoom-out (Compare Model Predictions
 * traces): a double-click must not also seek, twice, as it did before.
 */
import { describe, it, expect } from "../bun-test";
import { createClickGate } from "@/lib/plotClickGate";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createClickGate", () => {
  // A single click seeks, once the double-click time has passed.
  it("fires a lone click after the delay", async () => {
    const got: number[] = [];
    const gate = createClickGate(20, (x) => got.push(x));
    gate.click(5);
    expect(got).toEqual([]);
    await wait(40);
    expect(got).toEqual([5]);
  });

  // Review: double-click (zoom out) used to seek twice; now it seeks not at all.
  it("fires nothing for a double-click", async () => {
    const got: number[] = [];
    const gate = createClickGate(20, (x) => got.push(x));
    gate.click(5);
    gate.click(5);
    gate.doubleClick();
    await wait(40);
    expect(got).toEqual([]);
  });
});
