import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { useAppStore } from "@/stores/appStore";
import { toast } from "@/lib/notify";
import {
  showLabelingHint,
  hintIfFirstNodeConfirm,
  hintIfFirstPredictionConversion,
} from "@/lib/labelingHints";

describe("labelingHints", () => {
  beforeEach(() => {
    useAppStore.getState().set("showLabelingHints", true);
  });

  it("showLabelingHint is a no-op when the setting is off", () => {
    useAppStore.getState().set("showLabelingHints", false);
    const infoSpy = vi.spyOn(toast, "info");

    showLabelingHint("missing-nodes-right-click");

    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("showLabelingHint fires every time the setting is on, with no per-hint suppression", () => {
    const infoSpy = vi.spyOn(toast, "info");

    showLabelingHint("missing-nodes-right-click");
    showLabelingHint("missing-nodes-right-click");
    showLabelingHint("missing-nodes-right-click");

    // No dismissal/once tracking left (#341) -- the setting is the only gate.
    expect(infoSpy).toHaveBeenCalledTimes(3);
    infoSpy.mockRestore();
  });

  it("hintIfFirstNodeConfirm shows node-confirmed-color once, then mark-occluded-invisible once, then goes silent", () => {
    const infoSpy = vi.spyOn(toast, "info");

    // A no-op re-click on an already-complete node never counts.
    hintIfFirstNodeConfirm(/* wasAlreadyComplete */ true);
    expect(infoSpy).not.toHaveBeenCalled();

    // First genuine red->green transition this session -- the red/green
    // explanation.
    hintIfFirstNodeConfirm(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // The very next node confirmed -- since every placement method fills in
    // a real position for every node, there's no "still needs placing"
    // signal to hang the occlusion nudge off of, so it rides the next
    // available confirm event instead.
    hintIfFirstNodeConfirm(false);
    expect(infoSpy).toHaveBeenCalledTimes(2);

    // Both session-capped hints are now used up -- further confirms in the
    // SAME session must not re-show either toast (it would otherwise fire
    // once per node placed on every fresh instance).
    hintIfFirstNodeConfirm(false);
    hintIfFirstNodeConfirm(false);
    expect(infoSpy).toHaveBeenCalledTimes(2);

    infoSpy.mockRestore();
  });

  it("shows the occluded-node hint (#341)", () => {
    const infoSpy = vi.spyOn(toast, "info");

    showLabelingHint("mark-occluded-invisible");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("hintIfFirstPredictionConversion fires once per session and reports whether it fired", () => {
    const infoSpy = vi.spyOn(toast, "info");

    expect(hintIfFirstPredictionConversion()).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // A second conversion in the same session must not re-show the toast.
    expect(hintIfFirstPredictionConversion()).toBe(false);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
  });
});
