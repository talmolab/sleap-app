/**
 * Claude's corrected predictions in Compare Models' "Review disagreements"
 * window: the "Claude's suggestion" pane (next to the models' panes, or next
 * to the project's prediction when no models disagree or none are loaded),
 * Use / Revert / Reject / Undo reject, outdated, the queue order, the toast,
 * and that Claude's QC fixes stay in Label QC Review as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { Instance } from "@talmolab/sleap-io.js";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: toastInfo, warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore } = await import("@/stores/qcStore");
const { useProposalStore, poseOf, proposalState } = await import("@/stores/proposalStore");
const { useCompareReviewStore } = await import("@/stores/compareReviewStore");
const { useModelOverlayStore } = await import("@/stores/modelOverlayStore");
const { clearDisagreementIndexCache } = await import("@/lib/modelOverlay/disagreementIndex");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { CompareReviewWindow } = await import("@/components/video/compareReview/CompareReviewWindow");
const { QcReviewFrame } = await import("@/components/video/QcReviewFrame");
const { openClaudeSuggestions, handleProposalKey, currentProposal } = await import("@/lib/proposalReview");
const { buildEntries } = await import("@/components/video/compareReview/claudeEntries");
const { anomalyAt, loadPredictionFixture } = await import("./helpers/automationFixture");

let fx: ReturnType<typeof loadPredictionFixture>;
const store = () => useProposalStore.getState();
const review = () => useCompareReviewStore.getState();
const lf = (f: number) => fx.labels.find({ video: fx.video, frameIdx: f })[0];

/** A's tail moved 20.6 px (frame 30). */
const proposeA = () =>
  store().addCorrection(
    { flagId: "v0:f30:p0:aaaaaa", videoIdx: 0, frameIdx: 30, instIdx: 0, reason: "tail was on the floor" },
    { 2: [150, 125] },
    { pose: poseOf(fx.a) },
  );
/** C's nose moved 7 px (frame 40). */
const proposeC = () =>
  store().addCorrection(
    { flagId: "v0:f40:p0:cccccc", videoIdx: 0, frameIdx: 40, instIdx: 0, reason: "nose was on the wall" },
    { 0: [205, 95] },
    { pose: poseOf(fx.c) },
  );
/** B's tail moved 40 px (frame 30). */
const proposeB = () =>
  store().addCorrection(
    { flagId: "v0:f30:p1:bbbbbb", videoIdx: 0, frameIdx: 30, instIdx: 1, reason: "tail was on the wall" },
    { 2: [430, 160] },
    { pose: poseOf(fx.b) },
  );

/** Two Compare Models models that put B's tail 54 px apart on frame 30 (spread 27 px > the window's 25; still one animal). */
function loadModelsDisagreeingOnB() {
  const pose = (tailDy: number) => ({
    xy: new Float64Array([400, 100, 410, 110, 430, 120 + tailDy]),
    score: 0.9,
    trackName: null,
  });
  useModelOverlayStore.getState().addModels(fx.labels, [
    { name: "m1", source: "m1.slp", video: fx.video, frames: new Map([[30, [pose(0)]]]) },
    { name: "m2", source: "m2.slp", video: fx.video, frames: new Map([[30, [pose(54)]]]) },
  ]);
}

const position = () => screen.getByTestId("review-position").textContent?.replace(/\s+/g, " ");
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  setQcReviewedBackend(memoryBackend());
  fx = loadPredictionFixture();
  store().clear();
  useModelOverlayStore.getState().clear();
  clearDisagreementIndexCache();
  review().clearAll();
  review().setOpen(false);
  review().setFocusProposal(null);
  useQcStore.setState({ reviewOpen: false });
  toastInfo.mockClear();
});
afterEach(() => {
  cleanup();
  review().setOpen(false);
});

describe("Claude's suggestions in Review disagreements", () => {
  // Why: with no models loaded, Claude's corrections still get one review place, next to the project's prediction.
  it("opens with no models, on the first suggestion, next to the project's prediction", async () => {
    proposeC();
    proposeA();
    expect(openClaudeSuggestions()).toBe(true);
    expect(review().open).toBe(true);
    render(<CompareReviewWindow />);
    await flush();
    expect(screen.getByText("Review Claude's suggestions")).toBeTruthy();
    // Worst first: A's fix moves a node 20.6 px, C's 7 px.
    expect(position()).toContain("1 / 2");
    expect(position()).toContain("frame 30");
    expect(screen.getByTestId("review-prediction-pane")).toBeTruthy();
    expect(screen.getByTestId("review-claude-reason").textContent).toBe("tail was on the floor");
    expect(useAppStore.getState().frameIdx).toBe(30);
  });

  // Why: "Use this one" on Claude's pane accepts it (one edit) and moves on; the item stays reachable to Revert.
  it("Use this one accepts, then Revert brings the prediction back as a new edit", async () => {
    proposeA();
    proposeC();
    openClaudeSuggestions();
    render(<CompareReviewWindow />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-claude-use"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lf(30).userInstances[0].points[2].xy).toEqual([150, 125]);
    // Moved on to C.
    expect(position()).toContain("2 / 2");
    expect(screen.getByTestId("review-summary").textContent).toContain("1 accepted");
    fireEvent.click(screen.getByLabelText("Previous"));
    expect(screen.getByTestId("review-claude-status").textContent).toBe("Accepted");
    await act(async () => {
      fireEvent.click(screen.getByTestId("claude-revert"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lf(30).userInstances).toHaveLength(0);
    expect(lf(30).predictedInstances).toHaveLength(2);
    expect(screen.getByTestId("review-claude-status").textContent).toBe("Undone");
    expect((screen.getByTestId("review-claude-use") as HTMLButtonElement).disabled).toBe(false);
  });

  // Why: a reject changes no labels, so ⌘Z can't take it back; Undo reject must.
  it("Reject, then Undo reject makes it pending again", async () => {
    proposeA();
    openClaudeSuggestions();
    render(<CompareReviewWindow />);
    await flush();
    fireEvent.click(screen.getByTestId("review-claude-reject"));
    expect(screen.getByTestId("review-claude-status").textContent).toBe("Rejected");
    fireEvent.click(screen.getByTestId("claude-unreject"));
    expect(proposalState(store().proposals[0])).toBe("pending");
    expect(screen.getByTestId("review-claude-use")).toBeTruthy();
  });

  // Why: once the user labeled that animal, using Claude's suggestion would label it twice.
  it("shows an outdated suggestion that can't be used once the animal is labeled", async () => {
    proposeA();
    openClaudeSuggestions();
    render(<CompareReviewWindow />);
    await flush();
    act(() => {
      lf(30).instances.push(
        Instance.fromNumpy({
          pointsData: [
            [101, 100],
            [111, 110],
            [131, 121],
          ],
          skeleton: fx.skeleton,
        }),
      );
      useAppStore.getState().markChanged();
    });
    expect(screen.getByTestId("review-claude-status").textContent).toContain("Outdated");
    expect((screen.getByTestId("review-claude-use") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("review-prediction-use") as HTMLButtonElement).disabled).toBe(true);
  });

  // Why: the project's prediction is the other choice; using it labels the animal as the model had it.
  it("Use this one on the project's prediction turns it into a user instance as is", async () => {
    proposeA();
    openClaudeSuggestions();
    render(<CompareReviewWindow />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-prediction-use"));
      await new Promise((r) => setTimeout(r, 0));
    });
    const user = lf(30).userInstances[0];
    expect(user.fromPredicted).toBe(fx.a);
    expect(user.points[2].xy).toEqual([130, 120]);
    expect(proposalState(store().proposals[0])).toBe("outdated");
  });

  // Why: an animal the models disagree on and Claude corrected is one item, with Claude's pane beside the models'.
  it("adds Claude's pane to the models' item for the same animal, drawn even with H off", async () => {
    loadModelsDisagreeingOnB();
    proposeB();
    proposeA();
    useAppStore.setState({ showInstances: false });
    review().setOpen(true);
    render(<CompareReviewWindow />);
    await waitFor(() => expect(screen.getAllByTestId("review-pane")).toHaveLength(2));
    // B's disagreement (spread 27 px) first, with Claude's pane; A (20.6 px) is Claude's alone.
    expect(position()).toContain("1 / 2");
    expect(screen.getByTestId("review-claude-reason").textContent).toBe("tail was on the wall");
    expect(screen.queryByTestId("review-prediction-pane")).toBeNull();
    // Project instances start hidden in the window's cards (its own toggle, off on open).
    expect(screen.getByTestId("review-project-key").textContent).toContain("hidden");
    fireEvent.click(screen.getByLabelText("Next"));
    expect(screen.getByTestId("review-claude-reason").textContent).toBe("tail was on the floor");
    expect(screen.getByTestId("review-prediction-pane")).toBeTruthy();
  });

  // Why: the toast's Review button must land on Claude's first suggestion in this window.
  it("the toast's Review opens the window on the first suggestion", async () => {
    proposeC();
    proposeA();
    await new Promise((r) => setTimeout(r, 1700));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [msg, data] = toastInfo.mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(msg).toBe("Claude suggested 2 corrections");
    expect(data.action.label).toBe("Review");
    act(() => data.action.onClick());
    expect(review().open).toBe(true);
    expect(review().focusProposal).toBe(store().proposals.find((p) => p.frameIdx === 30)!.id);
  });

  // Why: corrections live in this window, so Label QC Review doesn't show or accept them.
  it("Label QC Review leaves corrections alone", () => {
    proposeA();
    useQcStore.setState({ reviewOpen: true });
    useAppStore.getState().setFrameIdx(30);
    useAppStore.getState().setInstance(fx.a);
    expect(currentProposal()).toBeNull();
    expect(handleProposalKey("accept")).toBe(false);
  });

  // Why: regression — Claude's QC fixes on the user's own labels must still show and accept in Label QC Review, unchanged.
  it("a QC fix on a flagged user instance still shows and accepts in Label QC Review", async () => {
    proposeA(); // a correction in the project doesn't get in the way
    await Promise.resolve(); // loadDismissed
    useQcStore.setState({
      labels: fx.labels,
      state: "done",
      findings: [],
      anomaly: { instances: [anomalyAt(20, 1, 0.9)], featureNames: [], gmmThreshold: 0.95 },
      threshold: 0.7,
      rescored: new Map(),
      reviewOpen: true,
    });
    useAppStore.getState().setFrameIdx(20);
    const user = lf(20).userInstances[1];
    useAppStore.getState().setInstance(user);
    store().addFix(
      { flagId: "v0:f20:i1:anomaly", videoIdx: 0, frameIdx: 20, instIdx: 1, reason: "nose was on the ear" },
      { 0: [5, 6] },
    );
    render(
      <QcReviewFrame>
        <div />
      </QcReviewFrame>,
    );
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("nose was on the ear");
    expect(handleProposalKey("accept")).toBe(true);
    await flush();
    expect(user.points[0].xy).toEqual([5, 6]);
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Accepted (Ctrl+Z to undo)");
    expect(screen.queryByTestId("claude-suggestions-link")).toBeNull();
  });
});

describe("Review window readability (hand-test 2026-11-24)", () => {
  // Hand-test: the summary sat squeezed next to the title; it's its own line naming the nodes.
  // Hand-test #538: the reason is 2 lines (buttons stay in view); clicking it shows it all, clicking again folds it.
  it("names the changed nodes under Claude's title and expands the reason on click", async () => {
    const long = "the tail tip was placed on the cage floor near the wall; the real tail runs along the bedding to the left of the animal ".repeat(2).trim();
    store().addCorrection(
      { flagId: "v0:f30:p0:aaaaaa", videoIdx: 0, frameIdx: 30, instIdx: 0, reason: long },
      { 2: [150, 125], 0: null },
      { pose: poseOf(fx.a) },
    );
    // Pretend the reason is taller than two lines (happy-dom doesn't lay text out).
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 90 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 30 });
    try {
      expect(openClaudeSuggestions()).toBe(true);
      render(<CompareReviewWindow />);
      await flush();
      const names = fx.a.skeleton.nodeNames;
      expect(screen.getByTestId("review-claude-summary").textContent).toBe(`Moves ${names[2]} · hides ${names[0]}`);
      const reason = screen.getByTestId("review-claude-reason");
      expect(reason.textContent).toBe(long);
      expect(reason.className).toContain("line-clamp-2");
      expect(screen.getByTestId("review-claude-reason-toggle").textContent).toBe("more");
      fireEvent.click(reason);
      expect(screen.getByTestId("review-claude-reason").className).not.toContain("line-clamp-2");
      expect(screen.getByTestId("review-claude-reason-toggle").textContent).toBe("less");
      fireEvent.click(screen.getByTestId("review-claude-reason-toggle"));
      expect(screen.getByTestId("review-claude-reason").className).toContain("line-clamp-2");
    } finally {
      // Put back what was there (or nothing: the getters may live on Element.prototype).
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, "clientHeight", ch);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });
});

describe("buildEntries", () => {
  // Why: only the newest correction per prediction is an item, so a re-proposal doesn't show twice.
  it("keeps the newest correction per prediction", () => {
    const first = proposeA();
    store().reject(first.id);
    const second = store().addCorrection(
      { flagId: "v0:f30:p0:aaaaaa", videoIdx: 0, frameIdx: 30, instIdx: 0, reason: "second look" },
      { 2: [140, 122] },
      { pose: poseOf(fx.a) },
    );
    const entries = buildEntries([], store().proposals, ["nose", "head", "tail"]);
    expect(entries.map((e) => e.claude?.id)).toEqual([second.id]);
  });
});
