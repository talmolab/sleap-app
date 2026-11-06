/**
 * Delete Instance and Track through the entry points a user actually hits:
 * Tracks ▸ Delete Instance and Track, and Ctrl/Cmd+Shift+Backspace. Both must
 * ask first (with the real count), delete nothing on Cancel, and delete the
 * track's instances in the current video only once confirmed.
 */

import { describe, it, expect, beforeEach, beforeAll } from "../bun-test";
import { render, renderHook, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import {
  Instance,
  Labels,
  LabeledFrame,
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

/** Main video: track A and B on frames 0-2. Other video: one A instance. */
function setupProject() {
  const sk = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const mk = (name: string) =>
    new Video({ filename: `/v/${name}.mp4`, backendMetadata: { shape: [10, 64, 64, 1] }, openBackend: false });
  const video = mk("main");
  const otherVideo = mk("other");
  const A = new Track("A");
  const B = new Track("B");
  const inst = (track: Track) => {
    const i = Instance.fromArray([[1, 2], [3, 4]], sk);
    i.track = track;
    return i;
  };
  const frames = [0, 1, 2].map(
    (frameIdx) => new LabeledFrame({ video, frameIdx, instances: [inst(A), inst(B)] })
  );
  const otherFrame = new LabeledFrame({ video: otherVideo, frameIdx: 0, instances: [inst(A)] });
  const labels = new Labels({
    videos: [video, otherVideo],
    skeletons: [sk],
    tracks: [A, B],
    labeledFrames: [...frames, otherFrame],
  });
  const store = useAppStore.getState();
  store.setLabels(labels, "test.slp");
  store.setVideo(video);
  store.setFrameIdx(1);
  store.setInstance(frames[1].instances[0]);
  return { labels, frames, otherFrame };
}

const trackCounts = (labels: Labels) => {
  const out: Record<string, number> = {};
  for (const lf of labels.labeledFrames) {
    for (const i of lf.instances) {
      const k = `${lf.video.filename.includes("other") ? "other" : "main"}:${i.track?.name}`;
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
};

const ORIGINAL = { "main:A": 3, "main:B": 3, "other:A": 1 };
const AFTER = { "main:B": 3, "other:A": 1 };

async function answer(ok: boolean) {
  await act(async () => {
    useConfirmStore.getState().respond(ok);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function chooseMenuItem(menu: string, item: string) {
  fireEvent.pointerDown(screen.getByRole("menuitem", { name: menu }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${item}`) }));
}

function pressDeleteShortcut() {
  // tinykeys' $mod is Meta on Apple platforms and Control elsewhere.
  const mac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      shiftKey: true,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
    })
  );
}

const PROMPT = 'Delete all 3 instances on track "A" in this video, including this one? The track itself is kept.';

describe("Tracks ▸ Delete Instance and Track", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    useConfirmStore.setState({ request: null });
  });

  it("asks with the count, and Cancel deletes nothing", async () => {
    const { labels } = setupProject();
    const { MenuBar } = await import("@/components/layout/MenuBar");
    render(<MenuBar />);

    chooseMenuItem("Tracks", "Delete Instance and Track");
    await act(async () => {});

    const request = useConfirmStore.getState().request;
    expect(request?.destructive).toBe(true);
    expect(request?.message).toBe(PROMPT);
    await answer(false);
    expect(trackCounts(labels)).toEqual(ORIGINAL);
    expect(useAppStore.getState().instance).not.toBeNull();
  });

  it("deletes the track's instances in this video once confirmed", async () => {
    const { labels } = setupProject();
    const { MenuBar } = await import("@/components/layout/MenuBar");
    render(<MenuBar />);

    chooseMenuItem("Tracks", "Delete Instance and Track");
    await act(async () => {});
    await answer(true);

    expect(trackCounts(labels)).toEqual(AFTER);
    expect(labels.tracks.map((t) => t.name)).toEqual(["A", "B"]);
  });
});

describe("Ctrl/Cmd+Shift+Backspace", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    useConfirmStore.setState({ request: null });
  });

  it("asks with the count, and Cancel deletes nothing", async () => {
    const { labels } = setupProject();
    renderHook(() => useKeyboardShortcuts());

    await act(async () => pressDeleteShortcut());

    expect(useConfirmStore.getState().request?.message).toBe(PROMPT);
    await answer(false);
    expect(trackCounts(labels)).toEqual(ORIGINAL);
  });

  it("deletes the track's instances in this video once confirmed", async () => {
    const { labels } = setupProject();
    renderHook(() => useKeyboardShortcuts());

    await act(async () => pressDeleteShortcut());
    await answer(true);

    expect(trackCounts(labels)).toEqual(AFTER);
  });
});
