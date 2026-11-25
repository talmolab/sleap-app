// Why: MCP clients reject tools with bad schemas, and Claude's arguments must be checked before anything runs.
import { describe, it, expect, beforeEach } from "../../bun-test";
import { useQcStore } from "@/stores/qcStore";
import { useProposalStore } from "@/stores/proposalStore";
import { setQcReviewedBackend, memoryBackend } from "@/lib/qcReviewed";
import { registry, TOOLS, bytesToBase64 } from "@/automation/tools";
import { validateArgs } from "@/automation/registry";
import { listQcFlags } from "@/automation/qcFlags";
import { rememberRender, clearRenders } from "@/automation/render";
import { AutomationError } from "@/automation/errors";
import { loadFixtureWithOneInstance, anomalyAt } from "../helpers/automationFixture";

let project: ReturnType<typeof loadFixtureWithOneInstance>;

async function seedQc() {
  project = loadFixtureWithOneInstance();
  await Promise.resolve(); // loadDismissed
  useQcStore.setState({
    labels: project.labels,
    state: "done",
    findings: [{ kind: "incomplete_frame", message: "Incomplete", video: project.video, videoIdx: 0, frameIdx: 20 }],
    anomaly: { instances: [anomalyAt(20, 1, 0.9)], featureNames: [], gmmThreshold: 0.95 },
    threshold: 0.7,
    rescored: new Map(),
  });
}

const json = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content.find((c) => c.type === "text")!.text!);

async function errCode(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return (e as AutomationError).code;
  }
  return null;
}

describe("tool registry", () => {
  beforeEach(async () => {
    setQcReviewedBackend(memoryBackend());
    useQcStore.getState().reset();
    useProposalStore.getState().clear();
    clearRenders();
    await seedQc();
  });

  // Why: every tool must carry what MCP's tools/list needs, or Claude Code won't load it.
  it("every tool has a name, description, object schema and read-only hint", () => {
    const names = new Set<string>();
    for (const t of registry.list()) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      // Schemas are plain JSON (they're sent over the wire as-is).
      expect(JSON.parse(JSON.stringify(t.inputSchema))).toEqual(t.inputSchema);
      for (const req of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(req);
    }
    expect(names.size).toBe(TOOLS.length);
    // Only the propose_ tools change anything (and only after the user accepts).
    expect(registry.list().filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort()).toEqual([
      "propose_correction",
      "propose_fix",
      "propose_ignore",
    ]);
  });

  // Why: the tool and the function behind it must agree.
  it("list_qc_flags returns the same flags as listQcFlags()", async () => {
    const out = json(await registry.call("list_qc_flags", {}));
    expect(out.total).toBe(2);
    expect(out.flags.map((f: { id: string }) => f.id)).toEqual(listQcFlags().map((f) => f.id));
    expect(out.flags[0].proposal).toBeNull();
  });

  // Why: Claude gives node names and picture pixels; the proposal must hold frame coordinates by node index.
  it("propose_fix converts picture pixels with the render's transform and adds one pending proposal", async () => {
    const r = rememberRender({
      flagId: "v0:f20:i1:anomaly",
      videoIdx: 0,
      frameIdx: 20,
      instIdx: 1,
      transform: { originX: 250, originY: 50, scale: 4, offsetX: 0, offsetY: 0 },
      width: 400,
      height: 400,
    });
    const out = json(
      await registry.call("propose_fix", {
        flag_id: "v0:f20:i1:anomaly",
        render_id: r.renderId,
        nodes: { nose: [40, 80], tail: null },
        reason: "nose was on the ear",
      }),
    );
    expect(out.status).toBe("pending");
    const [p] = useProposalStore.getState().proposals;
    expect(p.after).toEqual({ 0: [260, 70], 2: null });
    expect(p.instIdx).toBe(1);
    // Labels unchanged.
    const inst = project.labels.find({ video: project.video, frameIdx: 20 })[0].userInstances[1];
    expect(inst.points[0].xy).toEqual([300, 100]);
    const listed = json(await registry.call("list_proposals", {}));
    expect(listed.proposals[0]).toMatchObject({ flag_id: "v0:f20:i1:anomaly", status: "pending" });
    expect(listed.proposals[0].after).toEqual({ nose: [260, 70], tail: null });
  });

  // Why: a render from a project that was since closed has the old video's crop; using it would put nodes in the wrong place.
  it("refuses a render_id from another project", async () => {
    const { getRender } = await import("@/automation/render");
    const r = rememberRender({
      labels: project.labels,
      flagId: "v0:f20:i1:anomaly",
      videoIdx: 0,
      frameIdx: 20,
      instIdx: 1,
      transform: { originX: 0, originY: 0, scale: 1, offsetX: 0, offsetY: 0 },
      width: 100,
      height: 100,
    });
    expect(getRender(r.renderId).renderId).toBe(r.renderId);
    await seedQc(); // opens a new project (same flags)
    expect(
      await errCode(() =>
        registry.call("propose_fix", { flag_id: "v0:f20:i1:anomaly", render_id: r.renderId, nodes: { nose: [1, 1] }, reason: "x" }),
      ),
    ).toBe("UNKNOWN_RENDER");
  });

  // Why: if a node moved after Claude looked, its fix was made for a pose that isn't there any more.
  it("judges a fix against the pose Claude rendered", async () => {
    const inst = project.labels.find({ video: project.video, frameIdx: 20 })[0].userInstances[1];
    const renderedPose = inst.points.map((p) => [p.xy[0], p.xy[1], p.visible] as [number, number, boolean]);
    const r = rememberRender({
      labels: project.labels,
      pose: renderedPose,
      flagId: "v0:f20:i1:anomaly",
      videoIdx: 0,
      frameIdx: 20,
      instIdx: 1,
      transform: { originX: 0, originY: 0, scale: 1, offsetX: 0, offsetY: 0 },
      width: 400,
      height: 400,
    });
    inst.points[2].xy = [1, 2]; // the user moves a node after the render
    const out = json(
      await registry.call("propose_fix", { flag_id: "v0:f20:i1:anomaly", render_id: r.renderId, nodes: { nose: [5, 5] }, reason: "x" }),
    );
    expect(out.status).toBe("outdated");
    const { isOutdated } = await import("@/stores/proposalStore");
    expect(isOutdated(useProposalStore.getState().proposals[0])).toBe(true);
    // "before" is what Claude saw, not the pose now.
    expect(useProposalStore.getState().proposals[0].before).toEqual({ 0: [300, 100] });
  });

  // Why: mistakes in Claude's arguments should come back as readable errors, not crashes or wrong edits.
  it("rejects unknown tools, bad arguments, unknown nodes, wrong renders and off-picture points", async () => {
    expect(await errCode(() => registry.call("save_project", {}))).toBe("UNKNOWN_TOOL");
    expect(await errCode(() => registry.call("render_flag", {}))).toBe("BAD_INPUT");
    expect(await errCode(() => registry.call("list_qc_flags", { limit: "ten" }))).toBe("BAD_INPUT");
    expect(await errCode(() => registry.call("list_qc_flags", { verbose: true }))).toBe("BAD_INPUT");
    const r = rememberRender({
      flagId: "v0:f20:i1:anomaly",
      videoIdx: 0,
      frameIdx: 20,
      instIdx: 1,
      transform: { originX: 0, originY: 0, scale: 1, offsetX: 0, offsetY: 0 },
      width: 100,
      height: 100,
    });
    const fix = (nodes: unknown, flag_id = "v0:f20:i1:anomaly") =>
      registry.call("propose_fix", { flag_id, render_id: r.renderId, nodes, reason: "x" });
    expect(await errCode(() => fix({ snout: [1, 1] }))).toBe("BAD_INPUT");
    expect(await errCode(() => fix({ nose: [500, 1] }))).toBe("BAD_INPUT");
    expect(await errCode(() => fix({ nose: [1] }))).toBe("BAD_INPUT");
    expect(await errCode(() => fix({ nose: [1, 1] }, "v0:f20:i-:incomplete_frame"))).toBe("BAD_INPUT");
    expect(await errCode(() => fix({ nose: [1, 1] }, "v0:f10:i0:anomaly"))).toBe("UNKNOWN_FLAG");
    expect(useProposalStore.getState().proposals).toEqual([]);
    // callSafe turns the same errors into an MCP error result.
    const safe = await registry.callSafe("render_flag", {});
    expect(safe.isError).toBe(true);
    expect((safe.content[0] as { text: string }).text).toContain("flag_id is required");
  });

  // Why: Claude must learn that a proposal went stale or was undone, so it can look again.
  it("list_proposals reports outdated and undone proposals", async () => {
    const { SetNodes } = await import("@/commands/editCommands");
    const { useAppStore } = await import("@/stores/appStore");
    const p = useProposalStore.getState().addFix(
      { flagId: "v0:f20:i1:anomaly", videoIdx: 0, frameIdx: 20, instIdx: 1, reason: "r" },
      { 0: [1, 1] },
    );
    await useProposalStore.getState().accept(p.id, project.ctx);
    expect(json(await registry.call("list_proposals", {})).proposals[0].status).toBe("accepted");
    project.ctx.undo();
    expect(json(await registry.call("list_proposals", { status: "undone" })).proposals).toHaveLength(1);
    // Edit the instance: the undone proposal no longer matches the pose.
    useAppStore.getState().setInstance(useAppStore.getState().labeledFrame!.userInstances[1]);
    await project.ctx.execute(SetNodes, { nodes: { 2: [9, 9] } });
    expect(json(await registry.call("list_proposals", {})).proposals[0].status).toBe("accepted");
    const q = useProposalStore.getState().addFix(
      { flagId: "v0:f20:i1:anomaly", videoIdx: 0, frameIdx: 20, instIdx: 1, reason: "r2" },
      { 0: [2, 2] },
    );
    await project.ctx.execute(SetNodes, { nodes: { 2: [8, 8] } });
    const out = json(await registry.call("list_proposals", { status: "outdated" })).proposals;
    expect(out.map((x: { proposal_id: string }) => x.proposal_id)).toEqual([q.id]);
  });

  // Why: an ignore proposal is how Claude says "this pose is fine"; it must not change anything yet.
  it("propose_ignore adds a pending ignore", async () => {
    await registry.call("propose_ignore", { flag_id: "v0:f20:i1:anomaly", reason: "real rearing pose" });
    expect(useProposalStore.getState().proposals.map((p) => [p.kind, p.status])).toEqual([["ignore", "pending"]]);
    expect(useQcStore.getState().dismissed.size).toBe(0);
    const flags = json(await registry.call("list_qc_flags", {}));
    expect(flags.flags.find((f: { id: string }) => f.id === "v0:f20:i1:anomaly").proposal).toBe("pending");
  });

  // Why: get_session is Claude's first look; it must say whether QC has been run.
  it("get_session reports the project and QC state", async () => {
    const s = json(await registry.call("get_session", {}));
    expect(s.skeleton.nodes).toEqual(["nose", "head", "tail"]);
    expect(s.label_qc).toEqual({ state: "done", open_flags: 2 });
    useQcStore.getState().reset();
    const s2 = json(await registry.call("get_session", {}));
    expect(s2.label_qc.state).toBe("not run");
  });
});

describe("helpers", () => {
  // Why: the validator is the only thing between Claude's JSON and the handlers.
  it("validateArgs checks types, unions, enums and nested items", () => {
    const schema = { type: "object", properties: { n: { type: ["array", "null"], items: { type: "number" } } } };
    expect(validateArgs(schema, { n: null })).toBeNull();
    expect(validateArgs(schema, { n: [1, 2.5] })).toBeNull();
    expect(validateArgs(schema, { n: [1, "a"] })).toContain("n[1]");
    expect(validateArgs({ type: "string", enum: ["a"] }, "b")).toContain("one of");
    expect(validateArgs({ type: "number" }, NaN)).toContain("finite");
  });

  // Why: images go to Claude as base64; a large PNG must encode without blowing the call stack.
  it("bytesToBase64 encodes large arrays", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(Buffer.from(bytesToBase64(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  });
});
