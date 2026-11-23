/**
 * Claude's corrected predictions in the Review window: the "Claude suggests"
 * row for a correction, the ghost on the prediction, and Claude's-suggestions
 * mode (open from the toast, step with ← / →, works without a Label QC run).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: toastInfo, warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore, handleQcReviewKey } = await import("@/stores/qcStore");
const { useProposalStore, poseOf } = await import("@/stores/proposalStore");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { QcReviewFrame } = await import("@/components/video/QcReviewFrame");
const { openClaudeReview, handleProposalKey, currentProposal } = await import("@/lib/proposalReview");
const { proposalGhosts } = await import("@/hooks/useProposalGhosts");
const { loadPredictionFixture } = await import("./helpers/automationFixture");

let fx: ReturnType<typeof loadPredictionFixture>;
const store = () => useProposalStore.getState();
const app = () => useAppStore.getState();
const lf = (f: number) => fx.labels.find({ video: fx.video, frameIdx: f })[0];

/** Claude's corrections: A and B on frame 30, C on frame 40. */
function propose() {
  store().addCorrection(
    { flagId: "v0:f30:p0:aaaaaa", videoIdx: 0, frameIdx: 30, instIdx: 0, reason: "tail was on the floor" },
    { 2: [150, 125] },
    { pose: poseOf(fx.a) },
  );
  store().addCorrection(
    { flagId: "v0:f30:p1:bbbbbb", videoIdx: 0, frameIdx: 30, instIdx: 1, reason: "looks right" },
    {},
    { pose: poseOf(fx.b) },
  );
  store().addCorrection(
    { flagId: "v0:f40:p0:cccccc", videoIdx: 0, frameIdx: 40, instIdx: 0, reason: "nose was on the wall" },
    { 0: [205, 95] },
    { pose: poseOf(fx.c) },
  );
}

const renderReview = () =>
  render(
    <QcReviewFrame>
      <div />
    </QcReviewFrame>,
  );

beforeEach(() => {
  setQcReviewedBackend(memoryBackend());
  fx = loadPredictionFixture();
  store().clear();
  useQcStore.setState({ reviewOpen: false });
  toastInfo.mockClear();
});
afterEach(() => {
  useQcStore.setState({ reviewOpen: false });
  cleanup();
});

describe("Claude's suggestions mode", () => {
  // Why: corrections need no Label QC run; opening Review must go straight to the first one and select its prediction.
  it("opens on the first suggestion without a QC run, with its own header", () => {
    propose();
    expect(openClaudeReview()).toBe(true);
    expect(useQcStore.getState().reviewOpen).toBe(true);
    expect(store().claudeReview).toBe(true);
    expect(app().frameIdx).toBe(30);
    expect(app().instance).toBe(fx.a);
    renderReview();
    const header = screen.getByTestId("claude-review-header");
    expect(header.textContent).toContain("Claude's suggestions");
    expect(header.textContent).toContain("1 / 3");
    expect(header.textContent).toContain("3 to decide");
    // No QC run: no button back to QC flags.
    expect(screen.queryByRole("button", { name: "Label QC flags" })).toBeNull();
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("correct this prediction (move 1 node)");
  });

  // Why: → / ← step through every suggestion, including a second animal on the same frame.
  it("← / → step through suggestions, then wrap", () => {
    propose();
    openClaudeReview();
    expect(handleQcReviewKey("frame next")).toBe(true);
    expect([app().frameIdx, app().instance]).toEqual([30, fx.b]);
    handleQcReviewKey("frame next");
    expect([app().frameIdx, app().instance]).toEqual([40, fx.c]);
    handleQcReviewKey("frame next");
    expect([app().frameIdx, app().instance]).toEqual([30, fx.a]);
    handleQcReviewKey("frame prev");
    expect(app().frameIdx).toBe(40);
  });

  // Why: the footer's Prev / Next do the same as ← / →.
  it("footer Prev / Next step through suggestions", () => {
    propose();
    openClaudeReview();
    renderReview();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Next ›" })));
    expect(app().instance).toBe(fx.b);
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("accept this prediction as is");
    act(() => fireEvent.click(screen.getByRole("button", { name: "‹ Prev" })));
    expect(app().instance).toBe(fx.a);
  });

  // Why: A on a correction makes the prediction a label and the row says so; the queue keeps its place.
  it("A accepts the correction shown; the row then says it is a label", async () => {
    propose();
    openClaudeReview();
    renderReview();
    expect(handleProposalKey("accept")).toBe(true);
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(lf(30).userInstances[0].points[2].xy).toEqual([150, 125]);
    // The new user instance is selected, and its suggestion is still the one shown.
    expect(currentProposal()?.reason).toBe("tail was on the floor");
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Accepted as a label");
    expect(screen.getByTestId("claude-review-header").textContent).toContain("2 to decide");
  });

  // Why: the mode belongs to one opening of the window; Label QC review must work as before afterwards.
  it("closing Review leaves Claude's-suggestions mode, and ← / → go back to QC", () => {
    propose();
    openClaudeReview();
    useQcStore.getState().setReviewOpen(false);
    expect(store().claudeReview).toBe(false);
    useQcStore.getState().setReviewOpen(true);
    // QC mode with no run: the QC queue's hint, not a Claude step.
    const before = app().frameIdx;
    handleQcReviewKey("frame next");
    expect(app().frameIdx).toBe(before);
  });

  // Why: with nothing proposed, opening says so instead of showing an empty window.
  it("opening with no suggestions says so", () => {
    expect(openClaudeReview()).toBe(false);
    expect(useQcStore.getState().reviewOpen).toBe(false);
    expect(toastInfo).toHaveBeenCalled();
  });

  // Why: the proposed pose must be drawn over the prediction it would correct.
  it("draws a ghost over the prediction", () => {
    propose();
    const ghosts = proposalGhosts(store().proposals, lf(30), fx.video, 0);
    // A's correction moves its tail; B's "as is" has no moved nodes but is still drawn (unchanged).
    expect(ghosts.map((g) => g.instanceIdx)).toEqual([0, 1]);
    expect(ghosts[0].nodes[2]).toEqual({ kind: "move", x: 150, y: 125 });
    expect(ghosts[1].nodes.every((n) => n.kind === "same")).toBe(true);
  });

  // Why: the user must hear that Claude suggested something, with a way to open the Review window.
  it("tells the user once a batch of suggestions arrives", async () => {
    propose();
    await new Promise((r) => setTimeout(r, 1700));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [msg, data] = toastInfo.mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(msg).toBe("Claude suggested 3 changes");
    expect(data.action.label).toBe("Review");
    act(() => data.action.onClick());
    expect(store().claudeReview).toBe(true);
  });
});
