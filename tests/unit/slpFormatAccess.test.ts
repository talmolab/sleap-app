/**
 * SLP format refusals, the format 3.0 open-time choice and View only projects
 * (#509), with the helpers that carry `labeled` and metadata (#510). These run
 * against any sleap-io.js: errors and labels are stand-ins shaped like the
 * ones sleap-io.js 0.6 produces. tests/unit/slpFormat3RoundTrip.test.ts covers
 * real files once sleap-io.js reads format 3.0.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, info: toastInfo, warning: vi.fn() },
}));

import { Instance, LabeledFrame, Labels, Skeleton, Video } from "@talmolab/sleap-io.js";
import {
  copyMetadata,
  copyPoint,
  isPointLabeled,
  isSlpFormat3ChoiceError,
  isSlpFormatError,
  isSlpTableError,
  isSlpViewOnlyError,
  isUnlabeledPoint,
  isViewOnlyLabels,
  markPointLabeled,
  markSavedInLegacyLayout,
  metadataOf,
  setSourceAccess,
  withFormat3,
  withLegacyLayout,
  type Format3Summary,
  type SlpSourceFormat,
} from "@/lib/slpFormatCompat";
import {
  describeFormat3Drops,
  ensureWritable,
  isReportedSlpError,
  legacyCopyCommand,
  readWithFormatChoice,
  refuseEditIfViewOnly,
  refusalReason,
  SlpOpenCancelled,
  toastLoadError,
} from "@/lib/slpAccess";
import { useSlpFormatStore, type SlpFormatAnswer, type SlpFormatPrompt } from "@/stores/slpFormatStore";
import { useAppStore } from "@/stores/appStore";
import { CommandContext } from "@/commands/CommandContext";
import { SetPointLocation } from "@/commands/editCommands";

const SUMMARY: Format3Summary = {
  formatId: 3,
  unlabeledPoints: 3,
  unlabeledUserPoints: 2,
  unlabeledPredictedPoints: 1,
  metadataKeys: { instances: ["annotator"], frames: ["note"], bboxes: [] },
  unknownColumns: ["points/extra"],
  lossless: false,
};

/** An error shaped like sleap-io.js 0.5.17+'s `SlpFormatError`. */
function formatError(name: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error("The SLEAP labels file 'x.slp' is in SLP format 4.0 ...");
  e.name = name;
  Object.assign(e, { labelsPath: "/data/x.slp", formatId: 4, unsupportedFeatures: [], ...extra });
  return e;
}

/** Answer the next SLP format prompt with `answer`, recording it. */
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

function viewOnlyLabels(access: "view" | "edit" = "view"): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"] });
  const video = new Video({ filename: "v.mp4" });
  const inst = new Instance({
    skeleton,
    points: [
      { xy: [1, 2], visible: true, complete: true },
      { xy: [3, 4], visible: true, complete: true },
    ],
  });
  const labels = new Labels({
    labeledFrames: [new LabeledFrame({ video, frameIdx: 0, instances: [inst] })],
    videos: [video],
    skeletons: [skeleton],
  });
  const sf: SlpSourceFormat = { formatId: 3, access, summary: SUMMARY, labelsPath: "/data/x.slp" };
  (labels as unknown as { sourceFormat: SlpSourceFormat }).sourceFormat = sf;
  return labels;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useSlpFormatStore.setState({ prompt: null });
  toastInfo.mockClear();
  toastError.mockClear();
});

describe("error detection (shim)", () => {
  it("knows the refusal, the 3.0 choice and the view-only errors by name", () => {
    expect(isSlpFormatError(formatError("SlpFormatError"))).toBe(true);
    const choice = formatError("SlpFormat3ChoiceError", { formatId: 3, summary: SUMMARY });
    expect(isSlpFormatError(choice)).toBe(true);
    expect(isSlpFormat3ChoiceError(choice)).toBe(true);
    expect(isSlpFormat3ChoiceError(formatError("SlpFormatError"))).toBe(false);
    expect(isSlpFormatError(new Error("boom"))).toBe(false);
    const table = formatError("SlpTableError", { formatId: 3 });
    expect(isSlpFormatError(table)).toBe(true);
    expect(isSlpTableError(table)).toBe(true);
    expect(isSlpFormat3ChoiceError(table)).toBe(false);
    const viewOnly = new Error("view only");
    viewOnly.name = "SlpViewOnlyError";
    expect(isSlpViewOnlyError(viewOnly)).toBe(true);
    expect(isSlpViewOnlyError(new Error("x"))).toBe(false);
  });

  it("adds the reader and writer options without dropping the caller's", () => {
    expect(withFormat3({ openVideos: false }, "view") as unknown).toEqual({ openVideos: false, format3: "view" });
    expect(withFormat3({ openVideos: false }, undefined)).toEqual({ openVideos: false });
    expect(withLegacyLayout({ embed: "user" }) as unknown).toEqual({ embed: "user", unlabeledAs: "absent" });
    expect(withLegacyLayout() as unknown).toEqual({ unlabeledAs: "absent" });
  });
});

describe("points and metadata (shim)", () => {
  it("copies a point with its labeled flag, and only a false one", () => {
    const unlabeled = { xy: [Number.NaN, Number.NaN] as [number, number], visible: false, complete: false, labeled: false };
    const copy = copyPoint(unlabeled);
    expect(copy.labeled).toBe(false);
    expect(isUnlabeledPoint(copy)).toBe(true);
    const labelled = copyPoint({ xy: [1, 2], visible: false, complete: true, score: 0.5 });
    expect("labeled" in labelled).toBe(false);
    expect(labelled.score).toBe(0.5);
    expect(isUnlabeledPoint(labelled)).toBe(false);
    // A visible point counts as labelled whatever its flag.
    expect(isUnlabeledPoint({ xy: [1, 2], visible: true, complete: true, labeled: false } as never)).toBe(false);
  });

  it("marks a point labelled only where the point has the flag", () => {
    const p = { xy: [1, 2] as [number, number], visible: true, complete: true, labeled: false };
    markPointLabeled(p);
    expect(p.labeled).toBe(true);
    const old = { xy: [1, 2] as [number, number], visible: true, complete: true };
    markPointLabeled(old);
    expect("labeled" in old).toBe(false);
    expect(isPointLabeled(old)).toBe(true);
  });

  it("copies metadata as a new object, and ignores records without any", () => {
    const src = { metadata: { annotator: "someone", n: 2 } };
    const dst = copyMetadata(src, {} as { metadata?: Record<string, unknown> });
    expect(dst.metadata).toEqual({ annotator: "someone", n: 2 });
    expect(dst.metadata).not.toBe(src.metadata);
    expect(metadataOf({ metadata: {} })).toBeNull();
    expect(copyMetadata({}, {} as { metadata?: unknown }).metadata).toBeUndefined();
  });
});

describe("dialog text", () => {
  it("lists what saving in the 2.x layout drops", () => {
    const drops = describeFormat3Drops(SUMMARY);
    expect(drops[0]).toContain("3 nodes marked as not labeled");
    expect(drops[0]).toContain("2 in user instances, 1 in predictions");
    expect(drops[0]).toContain("hidden nodes with no position");
    const one = describeFormat3Drops({ ...SUMMARY, unlabeledPoints: 1, unlabeledUserPoints: 1, unlabeledPredictedPoints: 0 });
    expect(one[0]).toContain("1 node marked as not labeled (1 in user instances): saved as a hidden node");
    expect(drops).toContain("Instance metadata: annotator");
    expect(drops).toContain("Frame metadata: note");
    expect(drops.some((d) => d.includes("points/extra"))).toBe(true);
    expect(describeFormat3Drops({ ...SUMMARY, unreadTables: ["event_types", "events"] })).toContain(
      "Parts of the file this version doesn't read: event_types, events",
    );
    expect(
      describeFormat3Drops({
        ...SUMMARY,
        unlabeledPoints: 0,
        unlabeledUserPoints: 0,
        unlabeledPredictedPoints: 0,
        metadataKeys: { instances: [], frames: [], bboxes: [] },
        unknownColumns: [],
        lossless: true,
      }),
    ).toEqual([]);
  });

  it("says which tool reads a refused file, and how to save a copy", () => {
    expect(refusalReason(4, [])).toContain("newer tool");
    expect(refusalReason(2.8, ["fancy"])).toContain("fancy");
    expect(refusalReason(3, [])).toContain("Python sleap-io 0.10");
    expect(refusalReason(3, [], true)).toContain("inconsistent");
    const cmd = legacyCopyCommand("my data.slp");
    expect(cmd).toContain('sio.load_slp("my data.slp")');
    expect(cmd).toContain('"my data.v2.slp", legacy_format=True, unlabeled_as="absent"');
  });
});

describe("readWithFormatChoice", () => {
  it("asks for a 3.0 file and reads it again with the answer", async () => {
    const calls: Array<string | undefined> = [];
    const prompts = answerNextPrompt("view");
    const out = await readWithFormatChoice(
      async (access) => {
        calls.push(access);
        if (!access) throw formatError("SlpFormat3ChoiceError", { formatId: 3, summary: SUMMARY });
        return "labels";
      },
      "ask",
      "/data/x.slp",
    );
    expect(out).toBe("labels");
    expect(calls).toEqual([undefined, "view"]);
    expect(prompts[0]).toMatchObject({ kind: "open", fileName: "x.slp" });
  });

  it("a cancelled choice throws an error the callers don't toast", async () => {
    answerNextPrompt(null);
    let err: unknown;
    try {
      await readWithFormatChoice(
        async () => {
          throw formatError("SlpFormat3ChoiceError", { formatId: 3, summary: SUMMARY });
        },
        "ask",
        "x.slp",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SlpOpenCancelled);
    expect(isReportedSlpError(err)).toBe(true);
    toastLoadError("Failed to load project", err);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("merging offers only Merge or Cancel", async () => {
    const prompts = answerNextPrompt("edit");
    const calls: Array<string | undefined> = [];
    await readWithFormatChoice(
      async (access) => {
        calls.push(access);
        if (!access) throw formatError("SlpFormat3ChoiceError", { formatId: 3, summary: SUMMARY });
        return 1;
      },
      "merge",
      "donor.slp",
    );
    expect(prompts[0].kind).toBe("merge");
    expect(calls).toEqual([undefined, "edit"]);
  });

  it("passes a fixed choice straight to the reader, without asking", async () => {
    const calls: Array<string | undefined> = [];
    await readWithFormatChoice(async (access) => {
      calls.push(access);
      return 1;
    }, "view", "x.slp");
    expect(calls).toEqual(["view"]);
    expect(useSlpFormatStore.getState().prompt).toBeNull();
  });

  it("shows a refused file in its own dialog, and the error skips the toast", async () => {
    const prompts = answerNextPrompt("ok");
    const refused = formatError("SlpFormatError");
    await expect(
      readWithFormatChoice(async () => {
        throw refused;
      }, "ask", "x.slp"),
    ).rejects.toBe(refused);
    expect(prompts[0]).toMatchObject({ kind: "refused", fileName: "x.slp", formatId: 4 });
    expect(isReportedSlpError(refused)).toBe(true);
    toastLoadError("Failed to load project", refused);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("leaves other errors to the caller's toast", async () => {
    const other = new Error("not an HDF5 file");
    await expect(readWithFormatChoice(async () => { throw other; }, "ask", "x.slp")).rejects.toBe(other);
    expect(isReportedSlpError(other)).toBe(false);
    toastLoadError("Failed to load project", other);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("View only projects", () => {
  it("nothing is written unless the user allows editing", async () => {
    const labels = viewOnlyLabels();
    useAppStore.getState().setLabels(labels, "x.slp");
    expect(isViewOnlyLabels(labels)).toBe(true);

    const declined = answerNextPrompt(null);
    expect(await ensureWritable(labels, "save")).toBe(false);
    expect(declined[0]).toMatchObject({ kind: "allow-edit", action: "save", fileName: "x.slp" });
    expect(isViewOnlyLabels(labels)).toBe(true);

    answerNextPrompt("edit");
    expect(await ensureWritable(labels, "save")).toBe(true);
    expect(isViewOnlyLabels(labels)).toBe(false);
    // Labels opened for editing never ask.
    expect(await ensureWritable(viewOnlyLabels("edit"), "save")).toBe(true);
  });

  it("a save of edit-loaded labels clears sourceFormat; view-only labels keep it", () => {
    const edited = viewOnlyLabels("edit");
    markSavedInLegacyLayout(edited);
    expect((edited as unknown as { sourceFormat: unknown }).sourceFormat).toBeNull();
    const viewed = viewOnlyLabels("view");
    markSavedInLegacyLayout(viewed);
    expect(isViewOnlyLabels(viewed)).toBe(true);
  });

  it("setSourceAccess switches the labels' access without mutating the old source format", () => {
    const labels = viewOnlyLabels();
    const sf = (labels as unknown as { sourceFormat: SlpSourceFormat }).sourceFormat;
    setSourceAccess(labels, "edit");
    expect(isViewOnlyLabels(labels)).toBe(false);
    expect(sf.access).toBe("view"); // sleap-io.js freezes these: never mutated
  });

  it("commands refuse to edit it, and say how to allow editing", async () => {
    const labels = viewOnlyLabels();
    const store = useAppStore.getState();
    store.setLabels(labels, "x.slp");
    const inst = labels.labeledFrames[0].instances[0];
    useAppStore.setState({ instance: inst, labeledFrame: labels.labeledFrames[0] });
    const ctx = new CommandContext();

    expect(refuseEditIfViewOnly()).toBe(true);
    toastInfo.mockClear();
    await ctx.execute(SetPointLocation, { nodeIdx: 0, x: 50, y: 60 });
    expect(inst.points[0].xy).toEqual([1, 2]);
    expect(ctx.canUndo).toBe(false);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(String((toastInfo.mock.calls[0] as unknown[])[0])).toContain("View only");

    setSourceAccess(labels, "edit");
    expect(refuseEditIfViewOnly()).toBe(false);
    await ctx.execute(SetPointLocation, { nodeIdx: 0, x: 50, y: 60 });
    expect(inst.points[0].xy).toEqual([50, 60]);
  });
});
