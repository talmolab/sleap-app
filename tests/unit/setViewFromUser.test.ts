/**
 * `setViewFromUser`: the one store action for a view the user set by hand
 * (Alt+drag zoom box, Alt+double-click reset). Zoom modes that would snap the
 * view back on the next frame must turn off, or the zoom box is undone.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe("setViewFromUser", () => {
  // A zoom box hands VideoPlayer the new view and turns Fit View to Instances off.
  it("stores the view, bumps the signal and turns off fit modes", () => {
    useAppStore.setState({ fit: true, fitSelection: true });
    useAppStore.getState().setViewFromUser({ zoom: 3, panX: -10, panY: 20 });
    const s = useAppStore.getState();
    expect(s.userView).toEqual({ zoom: 3, panX: -10, panY: 20 });
    expect(s.userViewNonce).toBe(1);
    expect(s.fit).toBe(false);
    expect(s.fitSelection).toBe(false);
    expect(s.resetViewNonce).toBe(0);
  });

  // Alt+double-click resets through resetView, so whatever resetView clears applies too.
  it("resets the view through resetView when given null", () => {
    useAppStore.setState({ fit: true });
    useAppStore.getState().setViewFromUser(null);
    const s = useAppStore.getState();
    expect(s.resetViewNonce).toBe(1);
    expect(s.userViewNonce).toBe(0);
    expect(s.fit).toBe(false);
  });

  // The view is per session, like the rest of the canvas zoom.
  it("is not saved with the preferences", () => {
    expect(PERSISTED_KEYS).not.toContain("userView");
    expect(PERSISTED_KEYS).not.toContain("userViewNonce");
  });
});
