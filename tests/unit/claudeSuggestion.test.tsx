/**
 * Claude's proposals in the Label QC Review window: the "Claude suggests" row
 * (reason, Accept / Reject, outdated, ignore), the A / X keys, and the ghost
 * pose drawn on the canvas.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: toastError, info: vi.fn(), warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore } = await import("@/stores/qcStore");
const { useProposalStore } = await import("@/stores/proposalStore");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { commandContext, SetNodes } = await import("@/commands");
const { QcReviewFrame } = await import("@/components/video/QcReviewFrame");
const { handleProposalKey } = await import("@/lib/proposalReview");
const { proposalGhosts } = await import("@/hooks/useProposalGhosts");
const { ghostPose, renderProposalGhosts } = await import("@/canvas/proposalGhost");
const { makeAutomationProject, anomalyAt } = await import("./helpers/automationFixture");

let project: ReturnType<typeof makeAutomationProject>;
const target = { flagId: "v0:f20:i1:anomaly", videoIdx: 0, frameIdx: 20, instIdx: 1, reason: "nose was on the ear" };
const lf20 = () => project.labels.find({ video: project.video, frameIdx: 20 })[0];
const inst = () => lf20().userInstances[1];

/** The fixture project with a QC run, Review open on frame 20, its second instance selected. */
async function seed() {
  project = makeAutomationProject();
  useAppStore.getState().setLabels(project.labels, "clip.slp");
  await Promise.resolve(); // loadDismissed
  useQcStore.setState({
    labels: project.labels,
    state: "done",
    findings: [],
    anomaly: { instances: [anomalyAt(20, 1, 0.9)], featureNames: [], gmmThreshold: 0.95 },
    threshold: 0.7,
    rescored: new Map(),
    reviewOpen: true,
  });
  useAppStore.getState().setVideo(project.video);
  useAppStore.getState().setFrameIdx(20);
  useAppStore.getState().setInstance(inst());
}

const renderReview = () =>
  render(
    <QcReviewFrame>
      <div />
    </QcReviewFrame>,
  );

beforeEach(async () => {
  setQcReviewedBackend(memoryBackend());
  useProposalStore.getState().clear();
  commandContext.reset();
  toastError.mockClear();
  await seed();
});
afterEach(cleanup);

describe("Claude suggests row", () => {
  // Why: the user must see what Claude wants to change, and why, before accepting.
  it("shows the reason with Accept / Reject for a pending fix", () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6], 2: null });
    renderReview();
    const row = screen.getByTestId("claude-suggestion");
    expect(row.textContent).toContain("Claude suggests");
    expect(row.textContent).toContain("move 1 node, hide 1 node");
    expect(row.textContent).toContain("nose was on the ear");
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  // Why: no proposal, no row — the Review window looks as it did before.
  it("shows nothing without a proposal", () => {
    renderReview();
    expect(screen.queryByTestId("claude-suggestion")).toBeNull();
  });

  // Why: Accept applies the fix as one undo step and says how to take it back.
  it("Accept applies the fix and offers undo", async () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    renderReview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(inst().points[0].xy).toEqual([5, 6]);
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Accepted (Ctrl+Z to undo)");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(commandContext.undoCommandName).toBe("Claude: nose was on the ear");
    act(() => {
      commandContext.undo();
    });
    expect(inst().points[0].xy).toEqual([300, 100]);
  });

  // Why: after ⌘Z the fix is gone, so the row must not still say "Accepted"; it can be accepted again.
  it("shows Undone after ⌘Z and can be accepted again", async () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    renderReview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => {
      commandContext.undo();
    });
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Undone");
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(proposalGhosts(useProposalStore.getState().proposals, lf20(), project.video, 0)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(inst().points[0].xy).toEqual([5, 6]);
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Accepted");
  });

  // Why: a proposal made before the user edited the pose may be wrong now, so it can't be accepted.
  it("an outdated proposal can't be accepted", async () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    await commandContext.execute(SetNodes, { nodes: { 1: [1, 1] } });
    renderReview();
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Outdated");
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
    expect(handleProposalKey("accept")).toBe(true); // handled, but refused with a message
    await new Promise((r) => setTimeout(r, 0));
    expect(toastError).toHaveBeenCalled();
    expect(inst().points[0].xy).toEqual([300, 100]);
  });

  // Why: an "ignore" proposal reads differently and marks the instance OK, like key 3.
  it("an ignore proposal reads 'Ignore flag'", async () => {
    useProposalStore.getState().addIgnore({ ...target, reason: "real rearing pose" });
    renderReview();
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("ignore this flag");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ignore flag" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useQcStore.getState().dismissed.size).toBe(1);
  });

  // Why: Reject drops the suggestion and changes nothing.
  it("Reject leaves the pose alone", () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByTestId("claude-suggestion").textContent).toContain("Rejected");
    expect(inst().points[0].xy).toEqual([300, 100]);
  });
});

describe("A / X keys", () => {
  // Why: reviewers step with the keyboard; A and X act on the suggestion on screen.
  it("accept and reject the suggestion on screen, only in Review", async () => {
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    useQcStore.setState({ reviewOpen: false });
    expect(handleProposalKey("accept")).toBe(false);
    useQcStore.setState({ reviewOpen: true });
    expect(handleProposalKey("reject")).toBe(true);
    expect(useProposalStore.getState().proposals.find((x) => x.id === p.id)?.status).toBe("rejected");
    // Nothing pending left: the key isn't handled.
    expect(handleProposalKey("accept")).toBe(false);
  });

  // Why: with nothing selected, the frame's pending suggestion is the one the keys act on.
  it("falls back to the frame's pending suggestion when nothing is selected", async () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    useAppStore.getState().setInstance(null);
    expect(handleProposalKey("accept")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(inst().points[0].xy).toEqual([5, 6]);
  });
});

describe("ghost pose", () => {
  // Why: the ghost must sit on the right instance and show moved and hidden nodes.
  it("maps a pending fix to the drawn instance with moved / hidden / same nodes", () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6], 2: null });
    const ghosts = proposalGhosts(useProposalStore.getState().proposals, lf20(), project.video, 0);
    expect(ghosts).toEqual([
      { instanceIdx: 1, nodes: [{ kind: "move", x: 5, y: 6 }, { kind: "same" }, { kind: "hide" }] },
    ]);
    // Not drawn on other frames, or once decided.
    const other = project.labels.find({ video: project.video, frameIdx: 10 })[0];
    expect(proposalGhosts(useProposalStore.getState().proposals, other, project.video, 0)).toEqual([]);
    useProposalStore.getState().reject(useProposalStore.getState().proposals[0].id);
    expect(proposalGhosts(useProposalStore.getState().proposals, lf20(), project.video, 0)).toEqual([]);
  });

  // Why: on a cropped video the canvas draws crop-local pixels, not stored (source) ones.
  it("draws cropped videos in crop-local pixels", () => {
    const cropped = { cropRect: [100, 50, 400, 300] } as unknown as typeof project.video;
    useProposalStore.getState().addFix(target, { 0: [150, 80] });
    const [g] = proposalGhosts(useProposalStore.getState().proposals, lf20(), cropped, 0);
    expect(g.nodes[0]).toEqual({ kind: "move", x: 50, y: 30 });
  });

  // Why: the ghost pose is the whole pose after the fix, and drawing it mustn't throw.
  it("builds and draws the pose after the fix", () => {
    const rendered = {
      nodes: [
        { x: 0, y: 0, visible: true, complete: true, name: "a" },
        { x: 10, y: 0, visible: true, complete: true, name: "b" },
      ],
      edges: [{ srcIdx: 0, dstIdx: 1 }],
      color: [255, 0, 0] as [number, number, number],
      isPredicted: false,
      isSelected: false,
      trackName: null,
      visible: true,
      showNonVisible: true,
    };
    const nodes = [{ kind: "move" as const, x: 3, y: 4 }, { kind: "hide" as const }];
    expect(ghostPose(rendered, nodes)).toEqual([
      { x: 3, y: 4, visible: true },
      { x: 10, y: 0, visible: false },
    ]);
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (typeof k === "string" && !["strokeStyle", "fillStyle", "lineCap", "globalAlpha", "lineWidth"].includes(k) ? (..._a: unknown[]) => calls.push(k) : undefined),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    renderProposalGhosts(ctx, [rendered], [{ instanceIdx: 0, nodes }], { zoom: 1, markerSize: 4 });
    expect(calls).toContain("arc");
    expect(calls.filter((c) => c === "save").length).toBe(calls.filter((c) => c === "restore").length);
  });
});
