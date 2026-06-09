/**
 * Render tests for the Suggestions panel's generation-method UI (#162, Task 2).
 *
 * These prove the PANEL WIRING: each new generation method is reachable and
 * exposes its parameters, and clicking Generate dispatches the right method +
 * params into generateSuggestionFrames(...) and applies the result to the
 * store (labels.suggestions, with REPLACE semantics). Algorithm correctness is
 * covered by tests/unit/suggestionStrategies.test.ts — here the assertions are
 * on store state after Generate and on which param inputs render per method.
 *
 * Fixtures use REAL Labels/Video/Skeleton/PredictedInstance from
 * @talmolab/sleap-io.js with backend-less videos (explicit .shape); no decode.
 *
 * HAPPY-DOM LIMITATION — Radix <Select>: opening the Radix Select popover is
 * unreliable under happy-dom (it depends on pointer-capture / layout APIs and
 * a position:popper portal that happy-dom does not mount deterministically), so
 * we do NOT drive the method <Select> to switch methods. Instead the panel
 * exposes a tiny `initialMethod` test seam (defaulted to "stride" in
 * production) so a test can mount directly into a non-default method. The
 * Target <Select> is best-effort-driven once with pointer-capture polyfills and
 * gracefully falls back to the All-videos default assertion if the popover does
 * not open (the task explicitly permits this fallback). No timing hacks.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  LabeledFrame,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import type { SuggestionFrame } from "@/types";

// Toast is fire-and-forget here; stub it so Generate doesn't depend on sonner.
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

beforeAll(() => {
  // Radix Select/Slider read ResizeObserver at mount under happy-dom.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // Pointer-capture / scroll APIs Radix calls when opening; happy-dom lacks
  // them. Polyfilling lets the best-effort Target-select open succeed when it
  // can (we still tolerate it not opening).
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

/** Reset the store + unmount any prior render between tests. */
function resetStore() {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
}

/** Backend-less video with an explicit shape (no file to open). */
function makeVideo(frames: number, name = "test.mp4"): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [frames, 480, 640, 3] },
    openBackend: false,
  });
}

/** 2-node skeleton with one edge. */
function makeSkeleton(): Skeleton {
  const skel = new Skeleton({ nodes: ["a", "b"], name: "test" });
  skel.addEdge(skel.nodes[0], skel.nodes[1]);
  return skel;
}

/** A PredictedInstance with a frame-level score and visible points. */
function predictedInstance(
  skeleton: Skeleton,
  score: number,
): PredictedInstance {
  const inst = PredictedInstance.fromArray(
    [
      [1, 1],
      [2, 2],
    ],
    skeleton,
    score,
  );
  for (const p of inst.points) {
    p.visible = true;
    p.complete = true;
  }
  return inst;
}

/**
 * A PredictedInstance with an explicit INSTANCE score and a DIFFERENT per-point
 * score — so a test can tell which metric the Score column renders.
 */
function predictedInstanceScored(
  skeleton: Skeleton,
  instanceScore: number,
  pointScore: number,
): PredictedInstance {
  const inst = predictedInstance(skeleton, instanceScore);
  for (const p of inst.points) p.score = pointScore;
  return inst;
}

describe("SuggestionsPanel generation methods (#162)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("exposes each new method (mounted via the test seam) with its params + human label", async () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = new Labels({ videos: [video], skeletons: [skel] });
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );

    // Each method's distinctive param input(s) render, and the method trigger
    // shows the human label (proving the METHOD_LABELS mapping + Select value).
    const cases: Array<{
      method:
        | "frame_chunk"
        | "prediction_score"
        | "velocity"
        | "max_displacement";
      label: string;
      paramLabels: RegExp[];
    }> = [
      {
        method: "frame_chunk",
        label: "Frame chunk",
        paramLabels: [/frame chunk from/i, /frame chunk to/i],
      },
      {
        method: "prediction_score",
        label: "Prediction score",
        paramLabels: [/score limit/i, /instance limit lower/i],
      },
      {
        method: "velocity",
        label: "Velocity",
        paramLabels: [/velocity node/i, /velocity threshold/i],
      },
      {
        method: "max_displacement",
        label: "Max displacement",
        paramLabels: [/displacement threshold/i],
      },
    ];

    for (const c of cases) {
      cleanup();
      render(<SuggestionsPanel initialMethod={c.method} />);
      // The Select trigger displays the human label for the active method.
      expect(screen.getByLabelText(/generation method/i)).toHaveTextContent(
        c.label,
      );
      // The method's param inputs are present.
      for (const re of c.paramLabels) {
        expect(screen.getByLabelText(re)).toBeInTheDocument();
      }
    }
  });

  it("clamps the velocity threshold input to its [0, 1] domain", async () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = new Labels({ videos: [video], skeletons: [skel] });
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel initialMethod="velocity" />);

    const input = screen.getByLabelText(
      /velocity threshold/i,
    ) as HTMLInputElement;
    // An out-of-range value (> 1) is clamped to the upper bound 1; the
    // controlled input reflects the clamped state.
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("1");
    // A negative value is clamped to the lower bound 0.
    fireEvent.change(input, { target: { value: "-2" } });
    expect(input.value).toBe("0");
  });

  it("frame_chunk + Generate replaces labels.suggestions with the consecutive range", async () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = new Labels({ videos: [video], skeletons: [skel] });
    // Pre-existing suggestion to prove REPLACE semantics.
    labels.suggestions = [{ video, frameIdx: 99 } as SuggestionFrame];
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel initialMethod="frame_chunk" />);

    // Narrow the (1-based) chunk to a small deterministic window.
    fireEvent.change(screen.getByLabelText(/frame chunk from/i), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/frame chunk to/i), {
      target: { value: "6" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    // 1-based 3..6 inclusive -> 0-based 2,3,4,5. REPLACES the prior [99].
    const result = useAppStore.getState().labels?.suggestions ?? [];
    expect(result.map((s) => s.frameIdx)).toEqual([2, 3, 4, 5]);
    for (const s of result) expect(s.video).toBe(video);
  });

  it("prediction_score + Generate selects only the qualifying predicted frames", async () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = new Labels({ videos: [video], skeletons: [skel] });

    // frame 0: two low-score predicted (qualified=2, in [1,2]) -> include
    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(predictedInstance(skel, 1.0));
    lf0.instances.push(predictedInstance(skel, 2.0));
    // frame 5: three low-score predicted (qualified=3 > upper=2) -> exclude
    const lf5 = new LabeledFrame({ video, frameIdx: 5 });
    lf5.instances.push(predictedInstance(skel, 1.0));
    lf5.instances.push(predictedInstance(skel, 1.0));
    lf5.instances.push(predictedInstance(skel, 1.0));
    labels.labeledFrames.push(lf0, lf5);
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel initialMethod="prediction_score" />);

    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    // Defaults scoreLimit=3, lower=1, upper=2 -> only frame 0 qualifies.
    const result = useAppStore.getState().labels?.suggestions ?? [];
    expect(result.map((s) => s.frameIdx)).toEqual([0]);
  });

  it("Score column shows the mean INSTANCE score (matches Frames panel), not the point-score mean", async () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = new Labels({ videos: [video], skeletons: [skel] });
    // Instance score 0.40 but point scores 0.90. The Score column must render
    // 0.40 — the instance score the Frames panel + prediction_score use — NOT
    // the 0.90 point-score mean the panel previously (wrongly) displayed.
    const lf = new LabeledFrame({ video, frameIdx: 7 });
    lf.instances.push(predictedInstanceScored(skel, 0.4, 0.9));
    labels.labeledFrames.push(lf);
    labels.suggestions = [{ video, frameIdx: 7 } as SuggestionFrame];
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    expect(screen.getByText("0.40")).toBeInTheDocument();
    expect(screen.queryByText("0.90")).not.toBeInTheDocument();
  });

  it("default-method (stride) Generate replaces suggestions across ALL videos", async () => {
    // Default path: no Radix interaction. Default method is stride, Target
    // defaults to All videos.
    const skel = makeSkeleton();
    const v1 = makeVideo(100, "v1.mp4");
    const v2 = makeVideo(100, "v2.mp4");
    const labels = new Labels({ videos: [v1, v2], skeletons: [skel] });
    labels.suggestions = [];
    useAppStore.getState().setLabels(labels, "test.slp");

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    render(<SuggestionsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    const result = useAppStore.getState().labels?.suggestions ?? [];
    // Default perVideo (20) strided over 100 frames -> 20 per video, 2 videos.
    expect(result.length).toBe(40);
    expect(result.some((s) => s.video === v1)).toBe(true);
    expect(result.some((s) => s.video === v2)).toBe(true);
  });

  it("Target switches the video set (Current video restricts to the active video; else All-videos default spans both)", async () => {
    const skel = makeSkeleton();
    const v1 = makeVideo(100, "v1.mp4");
    const v2 = makeVideo(100, "v2.mp4");
    const labels = new Labels({ videos: [v1, v2], skeletons: [skel] });
    labels.suggestions = [];
    useAppStore.getState().setLabels(labels, "test.slp");
    // Make v2 the active video.
    useAppStore.getState().setVideo(v2);

    const { SuggestionsPanel } = await import(
      "@/components/panels/SuggestionsPanel"
    );
    // frame_chunk over both videos is deterministic and per-video, so the video
    // set is directly observable in the result.
    render(<SuggestionsPanel initialMethod="frame_chunk" />);
    fireEvent.change(screen.getByLabelText(/frame chunk from/i), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText(/frame chunk to/i), {
      target: { value: "3" },
    });

    // Best-effort: open the Target Select and click "Current video". If the
    // Radix popover doesn't open in happy-dom, fall back to the All-videos path.
    let switchedToCurrent = false;
    const targetTrigger = screen.getByLabelText(/target videos/i);
    fireEvent.pointerDown(targetTrigger, { button: 0, ctrlKey: false });
    const currentOption = screen.queryByRole("option", {
      name: /current video/i,
    });
    if (currentOption) {
      fireEvent.click(currentOption);
      switchedToCurrent =
        screen
          .getByLabelText(/target videos/i)
          .textContent?.toLowerCase()
          .includes("current") ?? false;
    }

    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    const result = useAppStore.getState().labels?.suggestions ?? [];
    expect(result.length).toBeGreaterThan(0);
    if (switchedToCurrent) {
      // Restricted to the active video (v2) only.
      expect(result.every((s) => s.video === v2)).toBe(true);
    } else {
      // Fallback (documented happy-dom limitation): All-videos default spans
      // both videos.
      expect(result.some((s) => s.video === v1)).toBe(true);
      expect(result.some((s) => s.video === v2)).toBe(true);
    }
  });
});
