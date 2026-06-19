/**
 * Render tests for the Suggestions panel controls (#159, Task 2).
 *
 * Exercises the wired-in buttons (Add current / Remove / Prev / Next / Clear),
 * the % labeled status line, and the Clear-all confirm dialog via real buttons
 * and real store reads. The list math itself is covered by Task 1's unit suite
 * (tests/unit/suggestionEdits.test.ts); these tests assert the panel behaviors.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
  type SuggestionFrame,
} from "@talmolab/sleap-io.js";

// Mock platform module (matches dialogs.test.tsx).
vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
}));

// Mock sonner toast so toast.info/success/error are no-ops here.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Radix Select/Dialog need ResizeObserver in happy-dom.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Build a backend-less project with a video that has a shape (so setFrameIdx
 * clamps sanely) and a skeleton with nodes (so we can add a user instance).
 */
function makeProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  return { labels, skeleton, video };
}

describe("SuggestionsPanel controls (#159)", () => {
  beforeEach(() => {
    cleanup();
    resetStore();
  });

  it("Add current frame appends the current (video, frameIdx) and de-dupes", async () => {
    const { labels, video } = makeProject();
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video); // resets frameIdx to 0
    useAppStore.getState().setFrameIdx(42);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    expect(useAppStore.getState().labels!.suggestions.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /add current/i }));

    await waitFor(() => {
      expect(useAppStore.getState().labels!.suggestions.length).toBe(1);
    });
    const added = useAppStore.getState().labels!.suggestions[0];
    expect(added.video).toBe(video);
    expect(added.frameIdx).toBe(42);

    // Clicking again must NOT add a duplicate.
    fireEvent.click(screen.getByRole("button", { name: /add current/i }));
    expect(useAppStore.getState().labels!.suggestions.length).toBe(1);
  });

  it("selecting a row then Remove deletes that specific suggestion", async () => {
    const { labels, video } = makeProject();
    labels.suggestions = [
      { video, frameIdx: 5 } as SuggestionFrame,
      { video, frameIdx: 10 } as SuggestionFrame,
      { video, frameIdx: 15 } as SuggestionFrame,
    ];
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    expect(useAppStore.getState().labels!.suggestions.length).toBe(3);

    // The middle suggestion (frameIdx 10) is rendered in a clickable row.
    const cell = screen.getByText("10");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => {
      expect(useAppStore.getState().labels!.suggestions.length).toBe(2);
    });
    const remaining = useAppStore
      .getState()
      .labels!.suggestions.map((s) => s.frameIdx);
    expect(remaining).toEqual([5, 15]);
  });

  it("Generate clears a stale selection (Remove disabled afterward)", async () => {
    const { labels, video } = makeProject();
    labels.suggestions = [
      { video, frameIdx: 5 } as SuggestionFrame,
      { video, frameIdx: 10 } as SuggestionFrame,
    ];
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    // Select a row -> Remove becomes enabled.
    fireEvent.click(screen.getByText("10").closest("tr")!);
    expect(screen.getByRole("button", { name: /^remove$/i })).not.toBeDisabled();

    // Generate replaces the list; selection must be cleared so Remove can no
    // longer delete a now-unrelated entry at the stale index.
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^remove$/i })).toBeDisabled();
    });
  });

  it("status line shows labeled/total and percentage", async () => {
    const { labels, skeleton, video } = makeProject();
    labels.suggestions = [
      { video, frameIdx: 0 } as SuggestionFrame,
      { video, frameIdx: 1 } as SuggestionFrame,
    ];
    // Give frame 0 a user (non-predicted) instance so it counts as labeled.
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    const inst = Instance.empty({ skeleton });
    lf.instances.push(inst);
    labels.labeledFrames.push(lf);

    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    // 1 of 2 labeled -> 50.0%.
    expect(
      screen.getByText(/1\/2 labeled \(50\.0%\)/)
    ).toBeInTheDocument();
  });

  it("status line + labeled dot update on label edit (overlayVersion), no remount (#159 AC4)", async () => {
    const { labels, skeleton, video } = makeProject();
    labels.suggestions = [{ video, frameIdx: 7 } as SuggestionFrame];
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    const { container } = render(<SuggestionsPanel />);

    // Initially the suggested frame has no user instance: 0/1 labeled, no dot.
    expect(screen.getByText(/0\/1 labeled \(0\.0%\)/)).toBeInTheDocument();
    expect(
      container.querySelectorAll('[title="Has user labels"]').length
    ).toBe(0);

    // Simulate labeling that frame on the canvas: seed a user (non-predicted)
    // Instance on its LabeledFrame, then bump the overlay-change signal. The
    // panel subscribes to overlayVersion, so it must re-render WITHOUT a remount.
    act(() => {
      const lf = new LabeledFrame({ video, frameIdx: 7 });
      lf.instances.push(Instance.empty({ skeleton }));
      labels.labeledFrames.push(lf);
      useAppStore.getState().bumpOverlayVersion();
    });

    await waitFor(() => {
      expect(
        screen.getByText(/1\/1 labeled \(100\.0%\)/)
      ).toBeInTheDocument();
    });
    expect(
      container.querySelectorAll('[title="Has user labels"]').length
    ).toBe(1);
  });

  it("Prev/Next are enabled with suggestions, disabled when empty", async () => {
    const { labels, video } = makeProject();
    labels.suggestions = [{ video, frameIdx: 3 } as SuggestionFrame];
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    const { rerender } = render(<SuggestionsPanel />);

    const prev = screen.getByRole("button", { name: /prev/i });
    const next = screen.getByRole("button", { name: /next/i });
    expect(prev).not.toBeDisabled();
    expect(next).not.toBeDisabled();

    // Empty the list and re-render: Prev/Next should be disabled.
    labels.suggestions = [];
    useAppStore.getState().markChanged();
    rerender(<SuggestionsPanel />);

    expect(screen.getByRole("button", { name: /prev/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("Clear opens a confirm dialog whose confirm empties the suggestions", async () => {
    const { labels, video } = makeProject();
    labels.suggestions = [
      { video, frameIdx: 1 } as SuggestionFrame,
      { video, frameIdx: 2 } as SuggestionFrame,
    ];
    useAppStore.getState().setLabels(labels, "test.slp");
    useAppStore.getState().setVideo(video);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    // Confirm dialog text appears.
    const confirmText = await screen.findByText(/cannot be undone/i);
    expect(confirmText).toBeInTheDocument();

    // The dialog's destructive confirm button empties the list.
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));

    await waitFor(() => {
      expect(useAppStore.getState().labels!.suggestions.length).toBe(0);
    });
  });
});
