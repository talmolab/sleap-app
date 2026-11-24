// Why: Claude only proposes; nothing may change until the user accepts, and stale proposals must be refused.
import { describe, it, expect, beforeEach } from "../../bun-test";
import { useAppStore } from "@/stores/appStore";
import { useQcStore } from "@/stores/qcStore";
import { useProposalStore, isOutdated } from "@/stores/proposalStore";
import { setQcReviewedBackend, memoryBackend } from "@/lib/qcReviewed";
import { SetNodes } from "@/commands/editCommands";
import type { CommandContext } from "@/commands/CommandContext";
import { AutomationError } from "@/automation/errors";
import { loadFixtureWithOneInstance } from "../helpers/automationFixture";

let ctx: CommandContext;
let project: ReturnType<typeof loadFixtureWithOneInstance>;

/** The second user instance on frame 20 (not the one selected at start). */
const target = { flagId: "v0:f20:i1:anomaly", videoIdx: 0, frameIdx: 20, instIdx: 1, reason: "nose was on the ear" };
const lf20 = () => project.labels.find({ video: project.video, frameIdx: 20 })[0];
const inst = () => lf20().userInstances[1];
const pose = () => inst().points.map((p) => [p.xy[0], p.xy[1], p.visible]);

async function codeOf(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    return (e as AutomationError).code;
  }
  return null;
}

describe("proposal store", () => {
  beforeEach(() => {
    setQcReviewedBackend(memoryBackend());
    project = loadFixtureWithOneInstance();
    ctx = project.ctx;
    useProposalStore.getState().clear();
  });

  // Why: proposing must not touch the labels.
  it("stores before/after and leaves the labels alone", () => {
    const start = pose();
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6], 2: null });
    expect(p.status).toBe("pending");
    expect(p.before).toEqual({ 0: [300, 100], 2: [330, 120] });
    expect(p.after).toEqual({ 0: [5, 6], 2: null });
    expect(pose()).toEqual(start);
    expect(ctx.canUndo).toBe(false);
  });

  // Why: accepting applies the fix to the right instance, and one ⌘Z takes it back.
  it("accept applies the fix as one undo step labeled with the reason", async () => {
    const start = pose();
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6], 2: null });
    await useProposalStore.getState().accept(p.id, ctx);
    expect(inst().points[0].xy).toEqual([5, 6]);
    expect(inst().points[2].visible).toBe(false);
    expect(useAppStore.getState().frameIdx).toBe(20);
    expect(useProposalStore.getState().proposals[0].status).toBe("accepted");
    expect(ctx.undoCommandName).toBe("Claude: nose was on the ear");
    ctx.undo();
    expect(pose()).toEqual(start);
    expect(ctx.canUndo).toBe(false);
  });

  // Why: Accept must edit the proposal's instance, never whichever instance happens to be selected.
  it("accept edits the proposal's instance even with another one selected", async () => {
    const other = lf20().userInstances[0];
    const otherPose = other.points.map((p) => [...p.xy]);
    useAppStore.getState().setFrameIdx(20);
    useAppStore.getState().setInstance(other);
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    // Pass no ctx, so accept awaits its import first; select the other instance meanwhile.
    const done = useProposalStore.getState().accept(p.id);
    useAppStore.getState().setInstance(other);
    await done;
    expect(inst().points[0].xy).toEqual([5, 6]);
    expect(other.points.map((q) => [...q.xy])).toEqual(otherPose);
  });

  // Why: a double click on Accept must apply the fix once, as one undo step.
  it("applies a fix once when accepted twice at the same time", async () => {
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    const results = await Promise.allSettled([
      useProposalStore.getState().accept(p.id),
      useProposalStore.getState().accept(p.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(inst().points[0].xy).toEqual([5, 6]);
  });

  // Why: if the user changed the pose after Claude looked, Claude's fix may be wrong now.
  it("refuses an outdated proposal", async () => {
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    useAppStore.getState().setFrameIdx(20);
    useAppStore.getState().setInstance(inst());
    await ctx.execute(SetNodes, { nodes: { 1: [1, 1] } });
    expect(isOutdated(useProposalStore.getState().proposals[0])).toBe(true);
    expect(await codeOf(() => useProposalStore.getState().accept(p.id, ctx))).toBe("OUTDATED");
    expect(inst().points[0].xy).toEqual([300, 100]);
  });

  // Why: rejecting must drop the proposal and change nothing.
  it("reject leaves labels unchanged", () => {
    const start = pose();
    const p = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    useProposalStore.getState().reject(p.id);
    expect(useProposalStore.getState().proposals[0].status).toBe("rejected");
    expect(pose()).toEqual(start);
  });

  // Why: an accepted "ignore" must do what key 3 does (mark the instance OK).
  it("accepting an ignore marks the instance OK", async () => {
    await Promise.resolve(); // loadDismissed
    const p = useProposalStore.getState().addIgnore(target);
    await useProposalStore.getState().accept(p.id, ctx);
    expect(useQcStore.getState().dismissed.size).toBe(1);
    expect(ctx.canUndo).toBe(false);
  });

  // Why: a newer proposal for the same flag replaces the older pending one, and a decided one can't be decided again.
  it("replaces a pending proposal for the same flag and refuses double decisions", async () => {
    const a = useProposalStore.getState().addFix(target, { 0: [5, 6] });
    const b = useProposalStore.getState().addFix(target, { 0: [7, 8] });
    expect(useProposalStore.getState().proposals.map((p) => p.id)).toEqual([b.id]);
    expect(await codeOf(() => useProposalStore.getState().accept(a.id, ctx))).toBe("UNKNOWN_PROPOSAL");
    useProposalStore.getState().reject(b.id);
    expect(await codeOf(() => useProposalStore.getState().accept(b.id, ctx))).toBe("NOT_PENDING");
  });

  // Why: proposals point at instances by position, so they can't survive opening another project.
  it("clears when another project loads", () => {
    useProposalStore.getState().addFix(target, { 0: [5, 6] });
    loadFixtureWithOneInstance();
    expect(useProposalStore.getState().proposals).toEqual([]);
  });
});
