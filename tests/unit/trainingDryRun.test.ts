/**
 * Reading `sleap-nn train --dry-run` output. The fixtures are real lines from
 * sleap-nn (main, after 0.3.5) and its 0.3.5 release, run with the argv the
 * app builds.
 */

import { describe, it, expect } from "../bun-test";
import {
  isDryRunUnsupported,
  parseDryRunSummary,
  removeDryRunLeftovers,
  type DryRunCleanupFs,
} from "@/lib/trainingDryRun";
import { buildTrainingArgs } from "@/platform/trainingArgs";

const PASSED = [
  "Epoch 0/0  ━━━━━━━━━━━━━━━━━━ 1/1 0:00:04 • 0:00:00 0.00it/s loss: 0.005        ",
  "                                                             val/loss: 0.005    ",
  "2026-11-02 11:53:53 | Finished training loop. [0.3 min]",
  "2026-11-02 11:53:53 | Dry run passed: setup, one training batch and one validation batch all ran. Nothing was written to disk.",
  "  Model type:          centroid",
  "  Labeled frames:      1 train, 1 val",
  "  Samples:             1 train, 1 val",
  "  Steps per epoch:     200 train, 1 val",
  "  Max epochs:          200",
  "  Model parameters:    1,953,105",
  "  Devices:             1 x mps:0",
  "  Run folder:          /data/models/260101_000000.centroid.n=1",
];

const FAILED = [
  '  File "h5py/h5f.pyx", line 104, in h5py.h5f.open',
  "FileNotFoundError: [Errno 2] Unable to synchronously open file (unable to open file: name = '/data/missing.slp', errno = 2)",
];

// sleap-nn 0.3.5 uses rich-click, which boxes the error.
const RICH_UNSUPPORTED = [
  "╭─ Error ──────────────────────────────────────────────────────────────────────╮",
  "│ No such option '--dry-run'.                                                  │",
  "╰──────────────────────────────────────────────────────────────────────────────╯",
  " Try 'sleap-nn [COMMAND] --help' for more information.",
];

describe("parseDryRunSummary", () => {
  it("reads every summary field, in order, from a passing run", () => {
    const fields = parseDryRunSummary(PASSED)!;
    expect(fields.map((f) => f.label)).toEqual([
      "Model type",
      "Labeled frames",
      "Samples",
      "Steps per epoch",
      "Max epochs",
      "Model parameters",
      "Devices",
      "Run folder",
    ]);
    expect(fields[3].value).toBe("200 train, 1 val");
    expect(fields[5].value).toBe("1,953,105");
    // A value containing ":" or "=" is kept whole.
    expect(fields[6].value).toBe("1 x mps:0");
    expect(fields[7].value).toBe("/data/models/260101_000000.centroid.n=1");
  });

  it("stops at the first line that isn't a summary field", () => {
    const fields = parseDryRunSummary([...PASSED, "2026-11-02 11:53:54 | Done.", "  Later:  value"])!;
    expect(fields).toHaveLength(8);
  });

  it("reads a resume's extra field", () => {
    const fields = parseDryRunSummary([...PASSED, "  Resumes from:        /data/models/run/last.ckpt"])!;
    expect(fields.at(-1)).toEqual({ label: "Resumes from", value: "/data/models/run/last.ckpt" });
  });

  it("is null when the run didn't pass", () => {
    expect(parseDryRunSummary(FAILED)).toBeNull();
    expect(parseDryRunSummary(RICH_UNSUPPORTED)).toBeNull();
    expect(parseDryRunSummary([])).toBeNull();
  });
});

describe("isDryRunUnsupported", () => {
  it("recognizes rich-click's boxed unknown-option error (sleap-nn 0.3.5)", () => {
    expect(isDryRunUnsupported(RICH_UNSUPPORTED)).toBe(true);
  });

  it("recognizes plain click's unknown-option error", () => {
    expect(isDryRunUnsupported(["Usage: sleap-nn train [OPTIONS]", "Error: No such option: --dry-run"])).toBe(true);
  });

  it("is false for a passing or an ordinarily failing run", () => {
    expect(isDryRunUnsupported(PASSED)).toBe(false);
    expect(isDryRunUnsupported(FAILED)).toBe(false);
  });
});

describe("buildTrainingArgs dryRun", () => {
  const base = {
    configFileName: "c.yaml",
    configDir: "/tmp",
    labelsPath: "/data/flies.slp",
    runName: "r",
    ckptDir: "/data/models",
  };

  it("appends --dry-run to a real run's argv, changing nothing else", () => {
    const real = buildTrainingArgs(base);
    expect(buildTrainingArgs({ ...base, dryRun: true })).toEqual([...real, "--dry-run"]);
  });

  it("leaves it off by default", () => {
    expect(buildTrainingArgs(base)).not.toContain("--dry-run");
  });
});

describe("removeDryRunLeftovers (after a Cancel killed sleap-nn)", () => {
  /** An in-memory folder tree: path -> child names (folders) or null (files). */
  function fakeFs(tree: Record<string, string[] | null>) {
    const removed: string[] = [];
    const fs: DryRunCleanupFs = {
      async readDir(path) {
        const children = tree[path];
        if (!children) throw new Error(`no folder ${path}`);
        return children.map((name) => ({ name, isDirectory: tree[`${path}/${name}`] !== null }));
      },
      async remove(path) {
        removed.push(path);
      },
    };
    return { fs, removed };
  }

  const RUN = "261102_164900.centroid.n=2";

  it("removes this run's scratch folders, and the model folder the dry run created", async () => {
    const { fs, removed } = fakeFs({
      "/data/models": [`.dryrun-${RUN}-96588`],
      [`/data/models/.dryrun-${RUN}-96588`]: [],
    });
    await removeDryRunLeftovers("/data/models", RUN, true, fs);
    expect(removed).toEqual([`/data/models/.dryrun-${RUN}-96588`, "/data/models"]);
  });

  it("keeps a model folder that was there before the dry run", async () => {
    const { fs, removed } = fakeFs({
      "/data/models": [`.dryrun-${RUN}-96588`],
      [`/data/models/.dryrun-${RUN}-96588`]: [],
    });
    await removeDryRunLeftovers("/data/models", RUN, false, fs);
    expect(removed).toEqual([`/data/models/.dryrun-${RUN}-96588`]);
  });

  it("never touches anything else: other runs, other dry runs, or files", async () => {
    const { fs, removed } = fakeFs({
      "/data/models": ["250101_000000.centroid.n=5", ".dryrun-other.run-1", `.dryrun-${RUN}-1.txt`],
      "/data/models/250101_000000.centroid.n=5": [],
      "/data/models/.dryrun-other.run-1": [],
      [`/data/models/.dryrun-${RUN}-1.txt`]: null,
    });
    await removeDryRunLeftovers("/data/models", RUN, true, fs);
    // Not even the model folder: it isn't empty.
    expect(removed).toEqual([]);
  });

  it("does nothing when the model folder isn't there", async () => {
    const { fs, removed } = fakeFs({});
    await removeDryRunLeftovers("/data/models", RUN, true, fs);
    expect(removed).toEqual([]);
  });
});
