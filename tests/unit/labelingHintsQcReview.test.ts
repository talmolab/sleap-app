/**
 * Labeling "Tip" toasts stay hidden while the Label QC Review window is open
 * (they'd cover it), without using up their once-per-session showing: the
 * same tip still comes up later in ordinary labeling.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { toast } from "@/lib/notify";
import {
  showLabelingHint,
  hintIfFirstNodeConfirm,
  hintIfFirstPredictionConversion,
} from "@/lib/labelingHints";

describe("labeling tips in Label QC Review", () => {
  beforeEach(() => {
    useAppStore.getState().set("showLabelingHints", true);
    useQcStore.setState({ reviewOpen: false });
  });

  it("are not shown in Review, and still shown outside it", () => {
    const infoSpy = vi.spyOn(toast, "info");
    useQcStore.setState({ reviewOpen: true });
    showLabelingHint("missing-nodes-right-click");
    expect(infoSpy).not.toHaveBeenCalled();
    useQcStore.setState({ reviewOpen: false });
    showLabelingHint("missing-nodes-right-click");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("a once-per-session tip held back in Review still shows later (not marked seen)", () => {
    const infoSpy = vi.spyOn(toast, "info");
    useQcStore.setState({ reviewOpen: true });
    hintIfFirstNodeConfirm(false); // placing a node in Review: "That node just turned green…"
    expect(hintIfFirstPredictionConversion()).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();

    useQcStore.setState({ reviewOpen: false });
    hintIfFirstNodeConfirm(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toBe("Tip");
    expect(hintIfFirstPredictionConversion()).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(2);
    infoSpy.mockRestore();
  });
});
