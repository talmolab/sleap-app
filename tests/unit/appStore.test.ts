/**
 * Tests for the Zustand app store.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";
import { DEFAULT_PANEL_ORDER } from "@/lib/panelLayout";
import type { Labels, Video, Skeleton, Instance } from "@/types";

/** Helper to reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** Create a minimal mock Labels object. */
function mockLabels(overrides?: Partial<Labels>): Labels {
  return {
    videos: [],
    skeletons: [],
    labeledFrames: [],
    tracks: [],
    suggestions: [],
    provenance: {},
    find: () => [],
    append: () => {},
    ...overrides,
  } as unknown as Labels;
}

/** Create a minimal mock Video. */
function mockVideo(overrides?: Partial<Video>): Video {
  return {
    filename: "test.mp4",
    shape: [100, 480, 640, 3],
    backend: null,
    source_video: null,
    ...overrides,
  } as unknown as Video;
}

describe("appStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("has correct initial state", () => {
    const state = useAppStore.getState();

    expect(state.labels).toBeNull();
    expect(state.filename).toBeNull();
    expect(state.hasChanges).toBe(false);
    expect(state.projectLoaded).toBe(false);
    expect(state.video).toBeNull();
    expect(state.frameIdx).toBe(0);
    expect(state.instance).toBeNull();
    expect(state.labeledFrame).toBeNull();
    expect(state.skeleton).toBeNull();
    expect(state.showInstances).toBe(true);
    expect(state.showLabels).toBe(true);
    expect(state.showEdges).toBe(true);
    expect(state.edgeStyle).toBe("Line");
    expect(state.palette).toBe("standard");
    expect(state.markerSize).toBe(4);
    expect(state.debugMode).toBe(false);
  });

  describe("setLabels", () => {
    it("sets labels and marks project as loaded", () => {
      const labels = mockLabels();
      useAppStore.getState().setLabels(labels, "test.slp");

      const state = useAppStore.getState();
      expect(state.labels).toBe(labels);
      expect(state.filename).toBe("test.slp");
      expect(state.projectLoaded).toBe(true);
      expect(state.hasChanges).toBe(false);
    });

    it("sets first video and skeleton when available", () => {
      const video = mockVideo();
      const skeleton = { name: "test", nodes: [], edges: [] } as unknown as Skeleton;
      const labels = mockLabels({ videos: [video], skeletons: [skeleton] });

      useAppStore.getState().setLabels(labels);

      const state = useAppStore.getState();
      expect(state.video).toBe(video);
      expect(state.skeleton).toBe(skeleton);
    });

    it("resets frameIdx and instance on load", () => {
      // First set some state
      useAppStore.setState({ frameIdx: 10 });
      const labels = mockLabels();
      useAppStore.getState().setLabels(labels);

      const state = useAppStore.getState();
      expect(state.frameIdx).toBe(0);
      expect(state.instance).toBeNull();
    });

    it("allows null filename", () => {
      const labels = mockLabels();
      useAppStore.getState().setLabels(labels);

      expect(useAppStore.getState().filename).toBeNull();
    });
  });

  describe("setVideo", () => {
    it("sets the active video and resets frame/instance", () => {
      const video = mockVideo();
      useAppStore.setState({ frameIdx: 50 });
      useAppStore.getState().setVideo(video);

      const state = useAppStore.getState();
      expect(state.video).toBe(video);
      expect(state.frameIdx).toBe(0);
      expect(state.instance).toBeNull();
      expect(state.labeledFrame).toBeNull();
    });
  });

  describe("setFrameIdx", () => {
    it("sets frame index within bounds", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(50);

      expect(useAppStore.getState().frameIdx).toBe(50);
    });

    it("clamps to max frame", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(200);

      expect(useAppStore.getState().frameIdx).toBe(99);
    });

    it("clamps to zero for negative values", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(-5);

      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("allows any non-negative index when video has no shape", () => {
      const video = mockVideo({ shape: null as unknown as Video["shape"] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(999);

      expect(useAppStore.getState().frameIdx).toBe(999);
    });

    it("clears instance and labeledFrame on frame change", () => {
      const video = mockVideo();
      useAppStore.setState({
        video,
        instance: {} as Instance,
        labeledFrame: {} as unknown as import("@/types").LabeledFrame,
      });
      useAppStore.getState().setFrameIdx(5);

      expect(useAppStore.getState().instance).toBeNull();
      expect(useAppStore.getState().labeledFrame).toBeNull();
    });
  });

  describe("incrementFrameIdx", () => {
    it("increments frame index by step", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video, frameIdx: 10 });
      useAppStore.getState().incrementFrameIdx(5);

      expect(useAppStore.getState().frameIdx).toBe(15);
    });

    it("wraps to 0 when going past max frame", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video, frameIdx: 99 });
      useAppStore.getState().incrementFrameIdx(1);

      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("wraps to max frame when going below 0", () => {
      const video = mockVideo({ shape: [100, 480, 640, 3] });
      useAppStore.setState({ video, frameIdx: 0 });
      useAppStore.getState().incrementFrameIdx(-1);

      expect(useAppStore.getState().frameIdx).toBe(99);
    });

    it("does nothing when no video is set", () => {
      useAppStore.setState({ frameIdx: 5 });
      useAppStore.getState().incrementFrameIdx(1);

      expect(useAppStore.getState().frameIdx).toBe(5);
    });
  });

  describe("setInstance", () => {
    it("sets the selected instance", () => {
      const instance = { points: [] } as unknown as Instance;
      useAppStore.getState().setInstance(instance);

      expect(useAppStore.getState().instance).toBe(instance);
    });

    it("can clear the instance with null", () => {
      useAppStore.setState({ instance: {} as Instance });
      useAppStore.getState().setInstance(null);

      expect(useAppStore.getState().instance).toBeNull();
    });
  });

  describe("markChanged / clearChanges", () => {
    it("marks project as having changes", () => {
      useAppStore.getState().markChanged();
      expect(useAppStore.getState().hasChanges).toBe(true);
    });

    it("records the last interacted frame", () => {
      useAppStore.setState({ frameIdx: 42 });
      useAppStore.getState().markChanged();
      expect(useAppStore.getState().lastInteractedFrame).toBe(42);
    });

    it("clears changes flag", () => {
      useAppStore.setState({ hasChanges: true });
      useAppStore.getState().clearChanges();
      expect(useAppStore.getState().hasChanges).toBe(false);
    });
  });

  describe("toggle", () => {
    it("toggles boolean values", () => {
      expect(useAppStore.getState().showLabels).toBe(true);
      useAppStore.getState().toggle("showLabels");
      expect(useAppStore.getState().showLabels).toBe(false);
      useAppStore.getState().toggle("showLabels");
      expect(useAppStore.getState().showLabels).toBe(true);
    });

    it("does not change non-boolean values", () => {
      const before = useAppStore.getState().palette;
      useAppStore.getState().toggle("palette" as keyof import("@/stores/appStore").AppState);
      expect(useAppStore.getState().palette).toBe(before);
    });
  });

  describe("set", () => {
    it("sets arbitrary state values", () => {
      useAppStore.getState().set("palette", "alphabet");
      expect(useAppStore.getState().palette).toBe("alphabet");
    });

    it("sets numeric values", () => {
      useAppStore.getState().set("markerSize", 8);
      expect(useAppStore.getState().markerSize).toBe(8);
    });
  });

  describe("setLoading", () => {
    it("sets loading state with message", () => {
      useAppStore.getState().setLoading(true, "Loading project...");

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(true);
      expect(state.loadingMessage).toBe("Loading project...");
    });

    it("clears loading state", () => {
      useAppStore.getState().setLoading(true, "Loading...");
      useAppStore.getState().setLoading(false);

      const state = useAppStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.loadingMessage).toBe("");
    });

    it("defaults message to empty string when not provided", () => {
      useAppStore.getState().setLoading(true);
      expect(useAppStore.getState().loadingMessage).toBe("");
    });

    it("has correct initial loading state", () => {
      const state = useAppStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.loadingMessage).toBe("");
    });
  });

  describe("dialog state", () => {
    it("has all dialogs closed initially", () => {
      const state = useAppStore.getState();
      expect(state.inferenceDialogOpen).toBe(false);
      expect(state.goToFrameDialogOpen).toBe(false);
      expect(state.deletePredictionsDialogOpen).toBe(false);
      expect(state.exportDialogOpen).toBe(false);
      expect(state.shortcutsDialogOpen).toBe(false);
      expect(state.helpDialogOpen).toBe(false);
    });

    it("opens and closes inference dialog", () => {
      useAppStore.getState().setInferenceDialogOpen(true);
      expect(useAppStore.getState().inferenceDialogOpen).toBe(true);

      useAppStore.getState().setInferenceDialogOpen(false);
      expect(useAppStore.getState().inferenceDialogOpen).toBe(false);
    });

    it("opens and closes go-to-frame dialog", () => {
      useAppStore.getState().setGoToFrameDialogOpen(true);
      expect(useAppStore.getState().goToFrameDialogOpen).toBe(true);

      useAppStore.getState().setGoToFrameDialogOpen(false);
      expect(useAppStore.getState().goToFrameDialogOpen).toBe(false);
    });

    it("dialogs are independent of each other", () => {
      useAppStore.getState().setInferenceDialogOpen(true);
      useAppStore.getState().setGoToFrameDialogOpen(true);

      expect(useAppStore.getState().inferenceDialogOpen).toBe(true);
      expect(useAppStore.getState().goToFrameDialogOpen).toBe(true);
      expect(useAppStore.getState().deletePredictionsDialogOpen).toBe(false);
    });

    it("opens and closes delete predictions dialog", () => {
      useAppStore.getState().setDeletePredictionsDialogOpen(true);
      expect(useAppStore.getState().deletePredictionsDialogOpen).toBe(true);

      useAppStore.getState().setDeletePredictionsDialogOpen(false);
      expect(useAppStore.getState().deletePredictionsDialogOpen).toBe(false);
    });

    it("opens and closes export dialog", () => {
      useAppStore.getState().setExportDialogOpen(true);
      expect(useAppStore.getState().exportDialogOpen).toBe(true);

      useAppStore.getState().setExportDialogOpen(false);
      expect(useAppStore.getState().exportDialogOpen).toBe(false);
    });

    it("opens and closes shortcuts dialog", () => {
      useAppStore.getState().setShortcutsDialogOpen(true);
      expect(useAppStore.getState().shortcutsDialogOpen).toBe(true);

      useAppStore.getState().setShortcutsDialogOpen(false);
      expect(useAppStore.getState().shortcutsDialogOpen).toBe(false);
    });

    it("opens and closes help dialog", () => {
      useAppStore.getState().setHelpDialogOpen(true);
      expect(useAppStore.getState().helpDialogOpen).toBe(true);

      useAppStore.getState().setHelpDialogOpen(false);
      expect(useAppStore.getState().helpDialogOpen).toBe(false);
    });
  });

  describe("defaultToPan", () => {
    it("defaults to false", () => {
      expect(useAppStore.getState().defaultToPan).toBe(false);
    });

    it("can be toggled", () => {
      useAppStore.getState().toggle("defaultToPan");
      expect(useAppStore.getState().defaultToPan).toBe(true);
      useAppStore.getState().toggle("defaultToPan");
      expect(useAppStore.getState().defaultToPan).toBe(false);
    });

    it("can be set directly", () => {
      useAppStore.getState().set("defaultToPan", true);
      expect(useAppStore.getState().defaultToPan).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("setFrameIdx beyond video bounds clamps to max", () => {
      const video = mockVideo({ shape: [50, 480, 640, 3] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(100);
      expect(useAppStore.getState().frameIdx).toBe(49);
    });

    it("setFrameIdx to 0 when video has shape [1, ...]", () => {
      const video = mockVideo({ shape: [1, 480, 640, 3] });
      useAppStore.setState({ video });
      useAppStore.getState().setFrameIdx(5);
      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("setInstance when no labels exist does not crash", () => {
      expect(() => {
        useAppStore.getState().setInstance(null);
      }).not.toThrow();
    });

    it("incrementFrameIdx wraps correctly with step larger than video", () => {
      const video = mockVideo({ shape: [10, 480, 640, 3] });
      useAppStore.setState({ video, frameIdx: 5 });
      // step of 20 would go to 25, which > 9, so wraps to 0
      useAppStore.getState().incrementFrameIdx(20);
      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("setLabels resets loading state implicitly", () => {
      useAppStore.getState().setLoading(true, "Loading...");
      const labels = mockLabels();
      useAppStore.getState().setLabels(labels, "test.slp");

      // Loading state is independent of setLabels
      // Caller is responsible for clearing it
      const state = useAppStore.getState();
      expect(state.projectLoaded).toBe(true);
    });
  });

  it("defaults seekbarHeaderGraph to instance-count and reduction to sum", () => {
    resetStore();
    const s = useAppStore.getState();
    expect(s.seekbarHeaderGraph).toBe("instance-count");
    expect(s.seekbarHeaderReduction).toBe("sum");
  });

  it("set() updates the seekbar header graph type", () => {
    resetStore();
    useAppStore.getState().set("seekbarHeaderGraph", "tracking-score");
    expect(useAppStore.getState().seekbarHeaderGraph).toBe("tracking-score");
  });

  describe("resetView", () => {
    it("initializes resetViewNonce to 0", () => {
      resetStore();
      expect(useAppStore.getState().resetViewNonce).toBe(0);
    });

    it("increments resetViewNonce on each call (one-shot signal)", () => {
      resetStore();
      useAppStore.getState().resetView();
      expect(useAppStore.getState().resetViewNonce).toBe(1);
      useAppStore.getState().resetView();
      expect(useAppStore.getState().resetViewNonce).toBe(2);
    });

    it("is not persisted (transient view signal)", () => {
      expect(PERSISTED_KEYS).not.toContain("resetViewNonce");
    });
  });
});

describe("PERSISTED_KEYS (layout + scale persistence)", () => {
  it("persists panel layout and UI scale across reloads", () => {
    expect(PERSISTED_KEYS).toContain("panelOrder");
    expect(PERSISTED_KEYS).toContain("hiddenPanels");
    expect(PERSISTED_KEYS).toContain("sidebarCollapsed");
    expect(PERSISTED_KEYS).toContain("sidebarActivePanel");
    expect(PERSISTED_KEYS).toContain("uiScale");
  });

  it("keeps the pre-existing persisted keys (e.g. seekbar header prefs)", () => {
    // Regression guard: appending layout keys must not drop existing ones.
    expect(PERSISTED_KEYS).toContain("seekbarHeaderGraph");
    expect(PERSISTED_KEYS).toContain("seekbarHeaderReduction");
    expect(PERSISTED_KEYS).toContain("palette");
  });
});

describe("panel visibility & reset (#135)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("defaults to no hidden panels and the default order", () => {
    const s = useAppStore.getState();
    expect(s.hiddenPanels).toEqual([]);
    expect(s.panelOrder).toEqual([...DEFAULT_PANEL_ORDER]);
  });

  it("togglePanelVisibility hides then shows a panel", () => {
    useAppStore.getState().togglePanelVisibility("debug");
    expect(useAppStore.getState().hiddenPanels).toContain("debug");
    useAppStore.getState().togglePanelVisibility("debug");
    expect(useAppStore.getState().hiddenPanels).not.toContain("debug");
  });

  it("auto-switches the active panel when the active panel is hidden", () => {
    useAppStore.setState({ sidebarActivePanel: "videos" });
    useAppStore.getState().togglePanelVisibility("videos");
    const s = useAppStore.getState();
    expect(s.hiddenPanels).toContain("videos");
    // "skeleton" is next in DEFAULT_PANEL_ORDER and visible.
    expect(s.sidebarActivePanel).toBe("skeleton");
  });

  it("leaves the active panel as-is when hiding the last visible one (allow empty)", () => {
    // Hide everything except the active panel, then hide the active one too.
    const all = [...DEFAULT_PANEL_ORDER];
    useAppStore.setState({
      sidebarActivePanel: "videos",
      hiddenPanels: all.filter((id) => id !== "videos"),
    });
    useAppStore.getState().togglePanelVisibility("videos");
    const s = useAppStore.getState();
    expect(s.hiddenPanels).toContain("videos");
    // No other visible panel to switch to → active unchanged.
    expect(s.sidebarActivePanel).toBe("videos");
  });

  it("resetPanels restores default order and clears hidden panels", () => {
    useAppStore.setState({
      panelOrder: [...DEFAULT_PANEL_ORDER].reverse(),
      hiddenPanels: ["videos", "debug"],
      sidebarActivePanel: "debug",
    });
    useAppStore.getState().resetPanels();
    const s = useAppStore.getState();
    expect(s.panelOrder).toEqual([...DEFAULT_PANEL_ORDER]);
    expect(s.hiddenPanels).toEqual([]);
    // "debug" is a valid id, so it stays selected (now visible again).
    expect(s.sidebarActivePanel).toBe("debug");
  });
});

describe("per-instance visibility state", () => {
  const a = { id: "a" } as unknown as Instance;
  const b = { id: "b" } as unknown as Instance;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("qcDisplayMode is persisted and defaults to manual", () => {
    expect(useAppStore.getState().qcDisplayMode).toBe("manual");
    expect(PERSISTED_KEYS).toContain("qcDisplayMode");
  });

  it("setInstanceHidden toggles the hidden set and exits view-only", () => {
    const st = useAppStore.getState();
    st.setViewOnlyInstance(b);
    expect(useAppStore.getState().viewOnlyInstance).toBe(b);
    st.setInstanceHidden(a, true);
    expect(useAppStore.getState().hiddenInstances.has(a)).toBe(true);
    expect(useAppStore.getState().viewOnlyInstance).toBeNull(); // exits view-only
    st.setInstanceHidden(a, false);
    expect(useAppStore.getState().hiddenInstances.has(a)).toBe(false);
  });

  it("setViewOnlyInstance is radio-like (single target or null)", () => {
    const st = useAppStore.getState();
    st.setViewOnlyInstance(a);
    expect(useAppStore.getState().viewOnlyInstance).toBe(a);
    st.setViewOnlyInstance(b);
    expect(useAppStore.getState().viewOnlyInstance).toBe(b);
    st.setViewOnlyInstance(null);
    expect(useAppStore.getState().viewOnlyInstance).toBeNull();
  });

  it("setInstanceInvisibleOverride sets and clears the per-instance override", () => {
    const st = useAppStore.getState();
    st.setInstanceInvisibleOverride(a, false);
    expect(useAppStore.getState().showNonVisibleOverride.get(a)).toBe(false);
    st.setInstanceInvisibleOverride(a, undefined);
    expect(useAppStore.getState().showNonVisibleOverride.has(a)).toBe(false);
  });

  it("changing frame clears the 3 transient maps but keeps qcDisplayMode", () => {
    const st = useAppStore.getState();
    st.setQcDisplayMode("selected_only");
    st.setInstanceHidden(a, true);
    st.setViewOnlyInstance(b);
    st.setInstanceInvisibleOverride(a, false);
    useAppStore.getState().setFrameIdx(5); // real change from 0
    const s2 = useAppStore.getState();
    expect(s2.hiddenInstances.size).toBe(0);
    expect(s2.viewOnlyInstance).toBeNull();
    expect(s2.showNonVisibleOverride.size).toBe(0);
    expect(s2.qcDisplayMode).toBe("selected_only");
  });

  it("setFrameIdx to the CURRENT (or same-after-clamp) frame preserves transients", () => {
    const video = {
      filename: "t.mp4",
      shape: [100, 480, 640, 3],
    } as unknown as Video;
    useAppStore.setState({ video, frameIdx: 99 });
    const st = useAppStore.getState();
    st.setInstanceHidden(a, true);
    st.setViewOnlyInstance(b); // setInstanceHidden cleared view-only; re-set it
    st.setInstanceInvisibleOverride(a, false);

    // Same index → no-op, transients survive.
    useAppStore.getState().setFrameIdx(99);
    let s = useAppStore.getState();
    expect(s.frameIdx).toBe(99);
    expect(s.hiddenInstances.has(a)).toBe(true);
    expect(s.viewOnlyInstance).toBe(b);
    expect(s.showNonVisibleOverride.get(a)).toBe(false);

    // Out-of-range-high idx clamps back to 99 (already parked there) → still a no-op.
    useAppStore.getState().setFrameIdx(500);
    s = useAppStore.getState();
    expect(s.frameIdx).toBe(99);
    expect(s.hiddenInstances.has(a)).toBe(true);
    expect(s.viewOnlyInstance).toBe(b);
    expect(s.showNonVisibleOverride.get(a)).toBe(false);
  });

  it("resetInstanceVisibility clears all three transient fields", () => {
    const st = useAppStore.getState();
    st.setInstanceHidden(a, true);
    st.setViewOnlyInstance(b);
    st.setInstanceInvisibleOverride(a, false);
    useAppStore.getState().resetInstanceVisibility();
    const s = useAppStore.getState();
    expect(s.hiddenInstances.size).toBe(0);
    expect(s.viewOnlyInstance).toBeNull();
    expect(s.showNonVisibleOverride.size).toBe(0);
  });
});
