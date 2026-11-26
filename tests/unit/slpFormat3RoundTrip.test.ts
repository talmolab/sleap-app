/**
 * SLP format 3.0 files end to end, through the app's own load, edit, undo,
 * autosave-journal, and save paths with `@talmolab/sleap-io.js` 0.6.0-alpha.0.
 *
 * The fixture `format3_unlabeled.slp` (written by Python sleap-io 0.10) holds
 * a user instance whose `tail` is not labeled, a hidden (labeled) `tail` on
 * another, frame metadata `note`, and instance metadata `annotator`.
 *
 * - A format 3.0 file with no unread tables opens directly for native 3.0
 *   editing (`access: "keep"`), with no open-time modal, and saves natively in
 *   format 3.0 preserving unlabeled nodes and metadata.
 * - A format 3.0 file carrying unread tables (e.g. `/events`) prompts View only
 *   vs Edit (drop unread tables): View only blocks edits and all writers until
 *   the user allows editing (`access: "keep"`); Cancel opens nothing and toasts
 *   nothing.
 * - A refused format 4.0 file opens the refusal dialog without a bare toast.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sio from "@talmolab/sleap-io.js";
import h5wasm from "h5wasm/node";

const toastError = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn(), warning: vi.fn() },
}));
// The fixture references external videos, which can't open under the test
// runner; video resolution is not what this file covers.
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
}));
// The app's Save writes through the platform: capture the bytes instead.
const savedFiles = new Map<string, Uint8Array>();
vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: true,
    writeFile: async (path: string, bytes: Uint8Array) => void savedFiles.set(path, bytes),
    showSaveDialog: async () => null,
  }),
}));

import { loadProjectFromPath } from "@/lib/loadProject";
import { loadSlp } from "@/lib/slpRead";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatStore, type SlpFormatAnswer, type SlpFormatPrompt } from "@/stores/slpFormatStore";
import { CommandContext } from "@/commands/CommandContext";
import { BeginEdit, SetPointLocation } from "@/commands/editCommands";
import {
  isSlpViewOnlyError,
  isUnlabeledPoint,
  metadataOf,
} from "@/lib/slpFormat";
import { allowEditing, countUnlabeledNodes, isProjectViewOnly } from "@/lib/slpAccess";
import { applyDeltas, buildBaseIndex, decodeJournal, encodeFrameDelta, frameDeltaToRecord } from "@/lib/autosaveJournal";
import { instanceNamedPoints } from "@/lib/instancePoints";
import { instanceGeometry } from "@/canvas/instanceGeometry";
import { qcPose } from "@/lib/analyze/qc/anomaly";
import { visibilityMask } from "@/lib/analyze/qc/util";
import { saveLabelsInPlace } from "@/lib/saveLabelsInPlace";
import { saveProjectAsSlp } from "@/lib/saveProject";

const FIXTURE = join(import.meta.dir, "../fixtures/format3_unlabeled.slp");
const FORMAT4 = join(import.meta.dir, "../fixtures/format4_stub.slp");
const readFile = async (p: string) => new Uint8Array(readFileSync(p));

const tmpDir = mkdtempSync(join(tmpdir(), "sleap-app-f3-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Copy `FIXTURE` and add an unread top-level `/events` group so sleap-io.js prompts. */
async function fixtureWithUnreadEvents(): Promise<string> {
  await h5wasm.ready;
  const outPath = join(tmpDir, "format3_unread_events.slp");
  writeFileSync(outPath, readFileSync(FIXTURE));
  const f = new h5wasm.File(outPath, "a");
  try {
    f.create_group("events");
  } finally {
    f.close();
  }
  return outPath;
}

const activeUnsubs: Array<() => void> = [];

/** Answer the next SLP format prompt with `answer`; returns the prompts seen. */
function answerNextPrompt(answer: SlpFormatAnswer): SlpFormatPrompt[] {
  const seen: SlpFormatPrompt[] = [];
  const unsub = useSlpFormatStore.subscribe((s) => {
    if (!s.prompt) return;
    seen.push(s.prompt);
    unsub();
    queueMicrotask(() => useSlpFormatStore.getState().respond(answer));
  });
  activeUnsubs.push(unsub);
  return seen;
}

/** Frame `frameIdx`'s user instances, in file order. */
function userInstances(labels: sio.Labels, frameIdx: number): sio.Instance[] {
  const lf = labels.labeledFrames.find((f) => f.frameIdx === frameIdx);
  return (lf?.instances ?? []).filter((i) => !(i instanceof sio.PredictedInstance));
}

const TAIL = 2;

beforeEach(() => {
  while (activeUnsubs.length) activeUnsubs.pop()!();
  savedFiles.clear();
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null });
  toastError.mockClear();
});

describe("format 3.0 native open, edit, journal, and save (no unread tables)", () => {
  it("opens directly as keep without prompting, and preserves unlabeled + metadata through edit, undo, journal and save", async () => {
    const prompts = answerNextPrompt("keep");
    expect(await loadProjectFromPath(FIXTURE, readFile)).toBe(true);
    // No unread tables → opens directly without any dialog!
    expect(prompts).toEqual([]);

    const labels = useAppStore.getState().labels!;
    expect(labels.sourceFormat?.formatId).toBe(3);
    expect(labels.sourceFormat?.access).toBe("keep");
    expect(isProjectViewOnly()).toBe(false);

    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    const [inst] = userInstances(labels, 0);
    const [hiddenTail] = userInstances(labels, 5);
    expect(isUnlabeledPoint(inst.points[TAIL])).toBe(true);
    expect(isUnlabeledPoint(hiddenTail.points[TAIL])).toBe(false);
    expect(metadataOf(lf)).toEqual({ note: "frame note" });
    expect(metadataOf(inst)).toEqual({ annotator: "someone" });
    expect(countUnlabeledNodes(labels)).toBe(1);

    // #511: shown as "not labeled", not drawn, and not missing for Label QC.
    expect(instanceNamedPoints(inst)[TAIL].labeled).toBe(false);
    expect(instanceNamedPoints(hiddenTail)[TAIL].labeled).toBe(true);
    expect(Number.isNaN(instanceGeometry(inst, null).nodes[TAIL].x)).toBe(true);
    expect(visibilityMask(qcPose(inst))[TAIL]).toBeNull();
    expect(visibilityMask(qcPose(hiddenTail))[TAIL]).toBe(false);

    // Edit one point as the canvas does (undo step, then the move), then undo and redo.
    useAppStore.setState({ instance: inst, labeledFrame: lf });
    const ctx = new CommandContext();
    await ctx.execute(BeginEdit);
    await ctx.execute(SetPointLocation, { nodeIdx: 0, x: 15, y: 25 });
    expect(inst.points[0].xy).toEqual([15, 25]);
    expect(ctx.undo()).toBe(true);
    let [restored] = userInstances(labels, 0);
    expect(restored.points[0].xy).toEqual([10, 20]);
    expect(isUnlabeledPoint(restored.points[TAIL])).toBe(true);
    expect(metadataOf(restored)).toEqual({ annotator: "someone" });
    expect(metadataOf(labels.labeledFrames.find((f) => f.frameIdx === 0)!)).toEqual({ note: "frame note" });
    expect(ctx.redo()).toBe(true);
    [restored] = userInstances(labels, 0);
    expect(restored.points[0].xy).toEqual([15, 25]);
    expect(isUnlabeledPoint(restored.points[TAIL])).toBe(true);
    expect(metadataOf(restored)).toEqual({ annotator: "someone" });

    // The autosave journal keeps the flag and metadata through a replay.
    const frame0 = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    const record = frameDeltaToRecord(encodeFrameDelta(frame0, buildBaseIndex(labels)));
    const { deltas } = decodeJournal(record);
    const base = await loadSlp(await readFile(FIXTURE), { openVideos: false, format3: "keep" });
    applyDeltas(base, deltas);
    const [replayed] = userInstances(base, 0);
    expect(replayed.points[0].xy).toEqual([15, 25]);
    expect(isUnlabeledPoint(replayed.points[TAIL])).toBe(true);
    expect(Number.isNaN(replayed.points[TAIL].xy[0])).toBe(true);
    expect(metadataOf(replayed)).toEqual({ annotator: "someone" });
    expect(metadataOf(base.labeledFrames.find((f) => f.frameIdx === 0)!)).toEqual({ note: "frame note" });

    // Save through the app's own Save (desktop branch, over the project's file)
    // and read back natively in format 3.0 without warnings.
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      await saveProjectAsSlp(labels, "format3_unlabeled.slp");
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
    expect(savedFiles.has(FIXTURE)).toBe(true);
    const bytes = savedFiles.get(FIXTURE)!;
    const back = await sio.loadSlp(bytes, { openVideos: false });
    expect(back.sourceFormat?.formatId).toBe(3);
    expect(back.sourceFormat?.access).toBe("keep");
    const backLf0 = back.labeledFrames.find((f) => f.frameIdx === 0)!;
    const [savedInst] = userInstances(back, 0);
    expect(savedInst.points[0].xy).toEqual([15, 25]);
    expect(savedInst.points[1].xy).toEqual([30, 40]);
    // Unlabeled node and metadata are preserved natively in SLP format 3.0!
    expect(isUnlabeledPoint(savedInst.points[TAIL])).toBe(true);
    expect(Number.isNaN(savedInst.points[TAIL].xy[0])).toBe(true);
    expect(metadataOf(backLf0)).toEqual({ note: "frame note" });
    expect(metadataOf(savedInst)).toEqual({ annotator: "someone" });
    const [savedHidden] = userInstances(back, 5);
    expect(savedHidden.points[TAIL].visible).toBe(false);
    expect(isUnlabeledPoint(savedHidden.points[TAIL])).toBe(false);
    // Saved natively in format 3.0: sourceFormat stays "keep".
    expect(labels.sourceFormat?.access).toBe("keep");
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("format 3.0 with unread tables prompts View only vs Edit (drop unread tables)", () => {
  it("View only blocks edits and writers until allowing editing switches to native keep", async () => {
    const unreadPath = await fixtureWithUnreadEvents();
    const prompts = answerNextPrompt("view");
    expect(await loadProjectFromPath(unreadPath, readFile)).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: "open", fileName: "format3_unread_events.slp" });
    if (prompts[0].kind === "open") {
      expect(prompts[0].summary.unreadTables).toContain("events");
    }

    const labels = useAppStore.getState().labels!;
    expect(isProjectViewOnly()).toBe(true);

    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    const [inst] = userInstances(labels, 0);
    useAppStore.setState({ instance: inst, labeledFrame: lf });
    const ctx = new CommandContext();
    await ctx.execute(BeginEdit);
    await ctx.execute(SetPointLocation, { nodeIdx: 0, x: 99, y: 99 });
    expect(inst.points[0].xy).toEqual([10, 20]);
    expect(ctx.canUndo).toBe(false);

    let writeErr: unknown;
    try {
      await sio.saveSlpToBytes(labels);
    } catch (e) {
      writeErr = e;
    }
    expect(isSlpViewOnlyError(writeErr)).toBe(true);
    let inPlaceErr: unknown;
    try {
      await saveLabelsInPlace(labels, "/nonexistent/x.slp");
    } catch (e) {
      inPlaceErr = e;
    }
    expect(isSlpViewOnlyError(inPlaceErr)).toBe(true);

    // Allowing editing switches access to "keep" so native format 3.0 saves succeed.
    answerNextPrompt("keep");
    expect(await allowEditing(labels)).toBe(true);
    expect(isProjectViewOnly()).toBe(false);
    expect(labels.sourceFormat?.access).toBe("keep");
    const bytes = await sio.saveSlpToBytes(labels);
    const back = await sio.loadSlp(bytes, { openVideos: false });
    expect(back.sourceFormat?.formatId).toBe(3);
    const [savedInst] = userInstances(back, 0);
    expect(isUnlabeledPoint(savedInst.points[TAIL])).toBe(true);
    // Records merged into another Labels carry the updated mark too.
    const elsewhere = new sio.Labels({ labeledFrames: [labels.labeledFrames[0]] });
    await sio.saveSlpToBytes(elsewhere);
  });

  it("Edit (drop unread tables) opens directly in native format 3.0 keep mode", async () => {
    const unreadPath = await fixtureWithUnreadEvents();
    const prompts = answerNextPrompt("keep");
    expect(await loadProjectFromPath(unreadPath, readFile)).toBe(true);
    expect(prompts).toHaveLength(1);
    const labels = useAppStore.getState().labels!;
    expect(labels.sourceFormat?.access).toBe("keep");
    expect(isProjectViewOnly()).toBe(false);
  });

  it("a cancelled choice opens nothing and toasts nothing", async () => {
    const unreadPath = await fixtureWithUnreadEvents();
    answerNextPrompt(null);
    expect(await loadProjectFromPath(unreadPath, readFile)).toBe(false);
    expect(useAppStore.getState().labels).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("a file sleap-io.js refuses", () => {
  it("gets its own dialog instead of the load-failure toast", async () => {
    const prompts = answerNextPrompt("ok");
    expect(await loadProjectFromPath(FORMAT4, readFile)).toBe(false);
    expect(prompts[0]).toMatchObject({ kind: "refused", fileName: "format4_stub.slp", formatId: 4 });
    expect(toastError).not.toHaveBeenCalled();
  });
});
