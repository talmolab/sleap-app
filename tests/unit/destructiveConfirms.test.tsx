/**
 * Destructive actions confirm through the app's own dialog (`confirmDialog`).
 *
 * They used to call `confirm()`. In the Tauri WebView that returns a Promise,
 * which is truthy, so `if (confirm(...))` went ahead without ever asking: on
 * desktop, Delete All Predictions and the track deletions ran unprompted.
 * Here a pending dialog must appear, Cancel must change nothing, and only a
 * confirm deletes. (An ESLint rule now rejects any new `confirm()`.)
 */

import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import {
  confirmDeleteInstanceAndTrack,
  confirmDeleteUnusedTracks,
} from "@/lib/trackDeleteConfirms";
import {
  Labels,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

function setupProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "v.mp4",
    backendMetadata: { shape: [10, 64, 64, 1] },
    openBackend: false,
  });
  const track = new Track("t1");
  const predicted = (frameIdx: number) =>
    new LabeledFrame({
      video,
      frameIdx,
      instances: [PredictedInstance.fromArray([[1, 2], [3, 4]], skeleton)],
    });
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks: [track],
    labeledFrames: [predicted(0), predicted(1), predicted(2)],
  });
  useAppStore.getState().setLabels(labels, "test.slp");
  return labels;
}

const predictionCount = (labels: Labels) =>
  labels.labeledFrames.reduce(
    (n, lf) => n + lf.instances.filter((i) => i instanceof PredictedInstance).length,
    0,
  );

async function renderMenuBar() {
  const { MenuBar } = await import("@/components/layout/MenuBar");
  render(<MenuBar />);
}

function chooseMenuItem(menu: string, item: string) {
  fireEvent.pointerDown(screen.getByRole("menuitem", { name: menu }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${item}`) }));
}

async function answer(ok: boolean) {
  await act(async () => {
    useConfirmStore.getState().respond(ok);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("destructive menu actions confirm in-app", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    useConfirmStore.setState({ request: null });
  });

  it("Delete All Predictions asks with the count, and Cancel deletes nothing", async () => {
    const labels = setupProject();
    await renderMenuBar();

    chooseMenuItem("Labels", "Delete All Predictions");
    await act(async () => {});

    const request = useConfirmStore.getState().request;
    expect(request?.destructive).toBe(true);
    expect(request?.message).toContain("There are 3 predicted instances");
    await answer(false);
    expect(predictionCount(labels)).toBe(3);
  });

  it("Delete All Predictions deletes once confirmed", async () => {
    const labels = setupProject();
    await renderMenuBar();

    chooseMenuItem("Labels", "Delete All Predictions");
    await act(async () => {});
    await answer(true);
    expect(predictionCount(labels)).toBe(0);
  });

  it("Delete All Tracks asks first, and Cancel keeps the tracks", async () => {
    const labels = setupProject();
    await renderMenuBar();

    chooseMenuItem("Tracks", "Delete All Tracks");
    await act(async () => {});

    expect(useConfirmStore.getState().request?.message).toContain("Delete ALL tracks?");
    await answer(false);
    expect(labels.tracks).toHaveLength(1);
  });
});

describe("shared track-delete prompts", () => {
  beforeEach(() => useConfirmStore.setState({ request: null }));

  for (const [label, ask, text] of [
    ["Delete Instance and Track", confirmDeleteInstanceAndTrack, "Delete this instance and its track?"],
    ["Delete Unused Tracks", confirmDeleteUnusedTracks, "Delete all unused tracks?"],
  ] as const) {
    it(`${label}: resolves with the user's answer`, async () => {
      const pending = ask();
      expect(useConfirmStore.getState().request?.message).toBe(text);
      expect(useConfirmStore.getState().request?.destructive).toBe(true);
      useConfirmStore.getState().respond(false);
      expect(await pending).toBe(false);

      const again = ask();
      useConfirmStore.getState().respond(true);
      expect(await again).toBe(true);
    });
  }
});
