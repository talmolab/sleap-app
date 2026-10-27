/**
 * Analysis export (HDF5 / CSV) — parity with PyQt SLEAP's File → Export
 * Analysis HDF5/CSV → Current Video / All Videos: which videos are exported,
 * PyQt's default file names, and the one-file vs folder flows. The desktop
 * platform (dialogs, file writes) is mocked; sleap-io is real.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import {
  analysisFilename,
  directoryOf,
  videosForAnalysis,
} from "@/lib/analysisExport";

const written: Array<{ path: string; size: number; text: string }> = [];
const dialogs: string[] = [];
let saveDialogResult: string | null = null;
let folderResult: string | null = null;
const toastSuccess = vi.fn((..._args: unknown[]) => {});
const toastInfo = vi.fn((..._args: unknown[]) => {});

const platform = {
  isTauri: true,
  showSaveDialog: async (o: { defaultName?: string }) => {
    dialogs.push(`save:${o.defaultName}`);
    return saveDialogResult;
  },
  showOpenDialog: async (o: { directory?: boolean }) => {
    dialogs.push(`open:${o.directory ? "dir" : "file"}`);
    return folderResult;
  },
  writeFile: async (path: string, bytes: Uint8Array) => {
    written.push({
      path,
      size: bytes.length,
      text: new TextDecoder().decode(bytes),
    });
  },
};
vi.mock("@/platform/index", () => ({
  getPlatform: async () => platform,
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@/lib/notify", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    warning: vi.fn(),
    info: toastInfo,
  },
}));

const { ExportAnalysisH5Command, ExportCSVCommand } = await import(
  "@/commands/fileCommands"
);

/** Three videos: `a` and `c` have labeled frames, `b` has none. */
function project() {
  const skeleton = new Skeleton({ nodes: ["head", "tail"] });
  const [a, b, c] = ["/data/a.mp4", "/data/b.mp4", "/data/sub/c.avi"].map(
    (filename) =>
      new Video({
        filename,
        backendMetadata: { shape: [10, 4, 4, 1] },
        openBackend: false,
      }),
  );
  const lf = (video: Video, frameIdx: number) =>
    new LabeledFrame({
      video,
      frameIdx,
      instances: [
        new Instance({ points: { head: [1, 2], tail: [3, 4] }, skeleton }),
      ],
    });
  const labels = new Labels({
    labeledFrames: [lf(a, 0), lf(a, 3), lf(c, 1)],
    videos: [a, b, c],
    skeletons: [skeleton],
  });
  return { labels, a, b, c };
}

/** The command context the commands read from. */
function ctx(labels: Labels, video: Video | null, projectPath: string | null) {
  const filename = projectPath ? projectPath.split("/").pop()! : null;
  return { state: { labels, video, filename, projectPath } } as never;
}

beforeEach(() => {
  written.length = 0;
  dialogs.length = 0;
  saveDialogResult = null;
  folderResult = null;
  toastSuccess.mockClear();
  toastInfo.mockClear();
});

describe("analysis export helpers (PyQt naming)", () => {
  it("names files {project}.{index:03}_{video}.analysis.{ext}", () => {
    const { labels, a, c } = project();
    expect(analysisFilename("labels.v001.slp", labels, a, "h5")).toBe(
      "labels.v001.000_a.analysis.h5",
    );
    expect(analysisFilename("/x/labels.v001.slp", labels, c, "csv")).toBe(
      "labels.v001.002_c.analysis.csv",
    );
    expect(analysisFilename(null, labels, a, "h5")).toBe(
      "labels.000_a.analysis.h5",
    );
  });

  it("uses an image sequence's first image name", () => {
    const skeleton = new Skeleton({ nodes: ["a"] });
    const seq = new Video({
      filename: ["/imgs/img_000.png", "/imgs/img_001.png"],
      openBackend: false,
    });
    const labels = new Labels({ videos: [seq], skeletons: [skeleton] });
    expect(analysisFilename("p.slp", labels, seq, "h5")).toBe(
      "p.000_img_000.analysis.h5",
    );
  });

  it("exports the current (or first) video, or all, skipping videos without labeled frames", () => {
    const { labels, a, b, c } = project();
    expect(videosForAnalysis(labels, c, false)).toEqual([c]);
    expect(videosForAnalysis(labels, null, false)).toEqual([a]);
    expect(videosForAnalysis(labels, b, false)).toEqual([]);
    expect(videosForAnalysis(labels, b, true)).toEqual([a, c]);
  });

  it("finds a path's folder", () => {
    expect(directoryOf("/data/proj/labels.slp")).toBe("/data/proj");
    expect(directoryOf("C:\\data\\labels.slp")).toBe("C:\\data");
    expect(directoryOf("labels.slp")).toBeNull();
    expect(directoryOf(null)).toBeNull();
  });
});

describe("Export Analysis HDF5 / CSV commands (desktop)", () => {
  it("Current Video: a Save dialog with PyQt's name in the project folder", async () => {
    const { labels, c } = project();
    saveDialogResult = "/data/proj/out.h5";
    await ExportAnalysisH5Command.execute(
      ctx(labels, c, "/data/proj/labels.v001.slp"),
    );

    expect(dialogs).toEqual(["save:/data/proj/labels.v001.002_c.analysis.h5"]);
    expect(written.map((w) => w.path)).toEqual(["/data/proj/out.h5"]);
    expect(written[0].size).toBeGreaterThan(0);
    expect(toastSuccess.mock.calls[0][0] as unknown).toBe("Analysis HDF5 exported");
  });

  it("All Videos: one folder, one file per video with labeled frames", async () => {
    const { labels, b } = project();
    folderResult = "/out";
    await ExportCSVCommand.execute(ctx(labels, b, "/data/proj/labels.slp"), {
      allVideos: true,
    });

    expect(dialogs).toEqual(["open:dir"]);
    expect(written.map((w) => w.path)).toEqual([
      "/out/labels.000_a.analysis.csv",
      "/out/labels.002_c.analysis.csv",
    ]);
    expect(toastSuccess.mock.calls[0][0] as unknown).toBe(
      "Analysis CSV: exported 2 files",
    );
  });

  it("writes each video's own CSV rows", async () => {
    const { labels } = project();
    folderResult = "/out";
    await ExportCSVCommand.execute(ctx(labels, null, "/p/l.slp"), {
      allVideos: true,
    });
    // a has frames 0 and 3, padded to its 10-frame span; c pads to its own.
    const [aCsv, cCsv] = written.map((w) => w.text.trim().split("\n"));
    expect(aCsv.length).toBe(1 + 10);
    expect(cCsv.length).toBe(1 + 10);
    expect(aCsv.join("\n")).not.toBe(cCsv.join("\n"));
  });

  it("does nothing when nothing is labeled in the chosen video", async () => {
    const { labels, b } = project();
    await ExportAnalysisH5Command.execute(ctx(labels, b, "/p/l.slp"));
    expect(dialogs).toEqual([]);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the dialog is cancelled", async () => {
    const { labels, a } = project();
    await ExportAnalysisH5Command.execute(ctx(labels, a, "/p/l.slp"));
    expect(written).toEqual([]);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
