/**
 * SLP format 3.0 files end to end, through the app's own load, edit, undo,
 * autosave-journal and save paths (#509, #510, #511).
 *
 * The fixture `format3_unlabeled.slp` (written by Python sleap-io 0.10) holds
 * a user instance whose `tail` is not labelled, a hidden (labelled) `tail` on
 * another, frame metadata `note` and instance metadata `annotator`.
 *
 * Needs a sleap-io.js that reads format 3.0 (0.6.0 or newer); with an older
 * one the suite skips itself and says so. The refusal test needs 0.5.17+.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sio from "@talmolab/sleap-io.js";

const toastError = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn(), warning: vi.fn() },
}));
// The fixture references external videos, which can't open under the test
// runner; video resolution is not what this file covers.
vi.mock("@/lib/resolveVideos", () => ({
  resolveExternalVideos: vi.fn(async () => {}),
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
  markSavedInLegacyLayout,
  metadataOf,
  sourceFormatOf,
  withLegacyLayout,
} from "@/lib/slpFormatCompat";
import { allowEditing, isProjectViewOnly } from "@/lib/slpAccess";
import { applyDeltas, buildBaseIndex, decodeJournal, encodeFrameDelta, frameDeltaToRecord } from "@/lib/autosaveJournal";
import { instanceNamedPoints } from "@/lib/instancePoints";
import { instanceGeometry } from "@/canvas/instanceGeometry";
import { qcPose } from "@/lib/analyze/qc/anomaly";
import { visibilityMask } from "@/lib/analyze/qc/util";
import { saveLabelsInPlace } from "@/lib/saveLabelsInPlace";

const HAS_FORMAT3 = "SlpFormat3ChoiceError" in sio;
const HAS_REFUSAL = "SlpFormatError" in sio;
if (!HAS_FORMAT3) {
  console.warn(
    "[slpFormat3RoundTrip] skipped: the installed sleap-io.js does not read SLP format 3.0 (needs 0.6.0 or newer)",
  );
}

const FIXTURE = join(import.meta.dir, "../fixtures/format3_unlabeled.slp");
const FORMAT4 = join(import.meta.dir, "../fixtures/format4_stub.slp");
const readFile = async (p: string) => new Uint8Array(readFileSync(p));

/** Answer the next SLP format prompt with `answer`; returns the prompts seen. */
function answerNextPrompt(answer: SlpFormatAnswer): SlpFormatPrompt[] {
  const seen: SlpFormatPrompt[] = [];
  const unsub = useSlpFormatStore.subscribe((s) => {
    if (!s.prompt) return;
    seen.push(s.prompt);
    unsub();
    queueMicrotask(() => useSlpFormatStore.getState().respond(answer));
  });
  return seen;
}

/** Frame `frameIdx`'s user instances, in file order. */
function userInstances(labels: sio.Labels, frameIdx: number): sio.Instance[] {
  const lf = labels.labeledFrames.find((f) => f.frameIdx === frameIdx);
  return (lf?.instances ?? []).filter((i) => !(i instanceof sio.PredictedInstance));
}

const TAIL = 2;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null });
  toastError.mockClear();
});

describe.skipIf(!HAS_FORMAT3)("format 3.0 opened for editing", () => {
  it("asks at open time, then carries labeled and metadata through edit, undo, journal and save", async () => {
    const prompts = answerNextPrompt("edit");
    expect(await loadProjectFromPath(FIXTURE, readFile)).toBe(true);
    expect(prompts[0]).toMatchObject({ kind: "open", fileName: "format3_unlabeled.slp" });
    expect(prompts[0].kind === "open" && prompts[0].summary.unlabeledUserPoints).toBe(1);

    const labels = useAppStore.getState().labels!;
    expect(sourceFormatOf(labels)?.access).toBe("edit");
    expect(isProjectViewOnly()).toBe(false);

    const lf = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    const [inst] = userInstances(labels, 0);
    const [hiddenTail] = userInstances(labels, 5);
    expect(isUnlabeledPoint(inst.points[TAIL])).toBe(true);
    expect(isUnlabeledPoint(hiddenTail.points[TAIL])).toBe(false);
    expect(metadataOf(lf)).toEqual({ note: "frame note" });
    expect(metadataOf(inst)).toEqual({ annotator: "someone" });

    // #511: shown as "not labelled", not drawn, and not missing for Label QC.
    expect(instanceNamedPoints(inst)[TAIL].labeled).toBe(false);
    expect(instanceNamedPoints(hiddenTail)[TAIL].labeled).toBe(true);
    expect(Number.isNaN(instanceGeometry(inst, null).nodes[TAIL].x)).toBe(true);
    expect(visibilityMask(qcPose(inst))[TAIL]).toBeNull();
    expect(visibilityMask(qcPose(hiddenTail))[TAIL]).toBe(false);

    // Edit one point as the canvas does (undo step, then the move), then undo
    // and redo it.
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

    // The autosave journal keeps the flag and the metadata through a replay.
    const frame0 = labels.labeledFrames.find((f) => f.frameIdx === 0)!;
    const record = frameDeltaToRecord(encodeFrameDelta(frame0, buildBaseIndex(labels)));
    const { deltas } = decodeJournal(record);
    const base = await loadSlp(await readFile(FIXTURE), { openVideos: false, format3: "edit" });
    applyDeltas(base, deltas);
    const [replayed] = userInstances(base, 0);
    expect(replayed.points[0].xy).toEqual([15, 25]);
    expect(isUnlabeledPoint(replayed.points[TAIL])).toBe(true);
    expect(Number.isNaN(replayed.points[TAIL].xy[0])).toBe(true);
    expect(metadataOf(replayed)).toEqual({ annotator: "someone" });
    expect(metadataOf(base.labeledFrames.find((f) => f.frameIdx === 0)!)).toEqual({ note: "frame note" });

    // The in-place save never patches a 3.0 file: it routes to a full re-save.
    const inPlace = await saveLabelsInPlace(labels, "/nonexistent/format3_unlabeled.slp");
    expect(inPlace.ok).toBe(false);

    // Save as the app does (2.x layout) and read the file back.
    const bytes = await sio.saveSlpToBytes(labels, withLegacyLayout());
    const back = await sio.loadSlp(bytes, { openVideos: false });
    expect(sourceFormatOf(back)).toBeNull(); // a 2.x file: no question
    const [savedInst] = userInstances(back, 0);
    expect(savedInst.points[0].xy).toEqual([15, 25]);
    expect(savedInst.points[1].xy).toEqual([30, 40]);
    // Not labelled → a hidden node with no position, as the open dialog said.
    expect(savedInst.points[TAIL].visible).toBe(false);
    expect(Number.isNaN(savedInst.points[TAIL].xy[0])).toBe(true);
    expect(isUnlabeledPoint(savedInst.points[TAIL])).toBe(false);
    const [savedHidden] = userInstances(back, 5);
    expect(savedHidden.points[TAIL].visible).toBe(false);
    // Saved over its own file: the app clears sourceFormat; later saves still
    // drop what the 2.x layout can't store, without asking again.
    markSavedInLegacyLayout(labels);
    expect(sourceFormatOf(labels)).toBeNull();
    await sio.saveSlpToBytes(labels, withLegacyLayout());
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_FORMAT3)("format 3.0 opened View only", () => {
  it("is not editable and no writer runs", async () => {
    const prompts = answerNextPrompt("view");
    expect(await loadProjectFromPath(FIXTURE, readFile)).toBe(true);
    expect(prompts[0].kind).toBe("open");
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
      await sio.saveSlpToBytes(labels, withLegacyLayout());
    } catch (e) {
      writeErr = e;
    }
    expect(isSlpViewOnlyError(writeErr)).toBe(true);
    await expect(saveLabelsInPlace(labels, "/nonexistent/x.slp")).rejects.toThrow(/View only/);

    // Allowing editing (in place, from the banner or a save prompt) lets every
    // writer through: the records share the labels' sourceFormat object.
    answerNextPrompt("edit");
    expect(await allowEditing(labels)).toBe(true);
    expect(isProjectViewOnly()).toBe(false);
    const bytes = await sio.saveSlpToBytes(labels, withLegacyLayout());
    const [savedInst] = userInstances(await sio.loadSlp(bytes, { openVideos: false }), 0);
    expect(savedInst.points[TAIL].visible).toBe(false);
    // ... including records the labels no longer hold, merged elsewhere.
    const elsewhere = new sio.Labels({ labeledFrames: [labels.labeledFrames[0]] });
    await sio.saveSlpToBytes(elsewhere, withLegacyLayout());
  });

  it("a cancelled choice opens nothing and toasts nothing", async () => {
    answerNextPrompt(null);
    expect(await loadProjectFromPath(FIXTURE, readFile)).toBe(false);
    expect(useAppStore.getState().labels).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_REFUSAL)("a file sleap-io.js refuses", () => {
  it("gets its own dialog instead of the load-failure toast", async () => {
    const prompts = answerNextPrompt("ok");
    expect(await loadProjectFromPath(FORMAT4, readFile)).toBe(false);
    expect(prompts[0]).toMatchObject({ kind: "refused", fileName: "format4_stub.slp", formatId: 4 });
    expect(toastError).not.toHaveBeenCalled();
  });
});
