import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore } from "@/stores/appStore";
import { applyQcVisibility } from "@/hooks/useQcVisibility";
import type { Instance } from "@/types";

const a = { id: "a" } as unknown as Instance;
const b = { id: "b" } as unknown as Instance;

describe("applyQcVisibility write-back", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("selected_only hides the non-selected instances", () => {
    applyQcVisibility("selected_only", b, [a, b], true);
    const s = useAppStore.getState();
    expect(s.hiddenInstances.has(a)).toBe(true);
    expect(s.hiddenInstances.has(b)).toBe(false);
    expect(s.showNonVisibleOverride.get(b)).toBe(true);
  });

  it("manual leaves the transient state untouched", () => {
    useAppStore.getState().setInstanceHidden(a, true);
    applyQcVisibility("manual", b, [a, b], true);
    expect(useAppStore.getState().hiddenInstances.has(a)).toBe(true);
  });
});
