/**
 * The app's .slp readers (src/lib/slpRead.ts): every read asks sleap-io.js to
 * repair point spans, and a repair sleap-io.js logs is shown as one warning.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

const toastWarning = vi.fn((..._args: unknown[]) => {});
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: toastWarning },
}));

// Stand-ins for sleap-io.js's readers: they return the options they got, and
// log whatever `nextWarnings` holds, as sleap-io.js does during a repair.
let nextWarnings: string[] = [];
const fakeRead = async (_source: unknown, options: unknown) => {
  for (const w of nextWarnings) console.warn(w);
  return options as never;
};
vi.mock("@talmolab/sleap-io.js", () => ({ loadSlp: fakeRead, readSlpStreaming: fakeRead }));

const { loadSlp, readSlpStreaming, pointSpanWarning, withPointSpanWarnings } = await import(
  "@/lib/slpRead"
);

const REPAIR =
  "[sleap-io] old.slp: 2 instances have more or fewer points than their skeleton has nodes " +
  "(first: frame 3, 3 points vs 2 nodes). Loaded their points as stored.";

beforeEach(() => {
  toastWarning.mockClear();
  nextWarnings = [];
});

describe("slpRead", () => {
  it("asks sleap-io.js to repair point spans, keeping the caller's options", async () => {
    const opts = (await loadSlp(new Uint8Array(), { openVideos: false })) as unknown as Record<string, unknown>;
    expect(opts).toEqual({ openVideos: false, repairPointSpans: true });
    const streamOpts = (await readSlpStreaming("x.slp" as never)) as unknown as Record<string, unknown>;
    expect(streamOpts).toEqual({ repairPointSpans: true });
  });

  it("shows one warning naming the file when sleap-io.js repaired it", async () => {
    nextWarnings = [REPAIR];
    await loadSlp(new Uint8Array());
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const [title, opts] = toastWarning.mock.calls[0] as unknown as [string, { description: string }];
    expect(title).toContain("didn't match their skeleton");
    expect(opts.description).toContain("old.slp: 2 instances");
    expect(opts.description).not.toContain("[sleap-io]");
  });

  it("shows nothing for a clean file or for other sleap-io.js warnings", async () => {
    await loadSlp(new Uint8Array());
    nextWarnings = ["[sleap-io] video not found: a.mp4", "something else"];
    await loadSlp(new Uint8Array());
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("puts console.warn back, even when the read throws", async () => {
    const original = console.warn;
    await expect(
      withPointSpanWarnings(async () => {
        throw new Error("bad file");
      }),
    ).rejects.toThrow("bad file");
    expect(console.warn).toBe(original);
    await loadSlp(new Uint8Array());
    expect(console.warn).toBe(original);
  });

  it("gives each of two overlapping reads its own warnings", async () => {
    let release!: () => void;
    const slow = withPointSpanWarnings(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    nextWarnings = [REPAIR];
    await loadSlp(new Uint8Array());
    release();
    await slow;
    // The repair happened while both were running, so both report it.
    expect(toastWarning).toHaveBeenCalledTimes(2);
  });

  it("recognises both of sleap-io.js's repair messages", () => {
    expect(pointSpanWarning([REPAIR])).toContain("old.slp");
    expect(
      pointSpanWarning(["[sleap-io] a.slp: rebuilt the point spans of 4 instances whose boundaries had shifted."]),
    ).toContain("rebuilt the point spans");
    expect(pointSpanWarning(["[sleap-io] something unrelated"])).toBeNull();
    expect(pointSpanWarning(["no prefix: point spans"])).toBeNull();
  });
});
