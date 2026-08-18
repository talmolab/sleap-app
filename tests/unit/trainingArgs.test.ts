import { describe, expect, test } from "bun:test";
import { buildTrainingArgs, hydraQuote } from "@/platform/trainingArgs";

const base = {
  configFileName: "sleap_train_config_123.yaml",
  configDir: "/tmp",
  labelsPath: "/Users/a/flies.slp",
  runName: "250818_143022.centroid.n=13",
  ckptDir: "/Users/a/models",
};

describe("hydraQuote", () => {
  test("wraps a value in single quotes", () => {
    expect(hydraQuote("foo")).toBe("'foo'");
  });

  test("preserves an embedded '=' (the run-name .n= case) inside the quotes", () => {
    expect(hydraQuote("250818.centroid.n=13")).toBe("'250818.centroid.n=13'");
  });

  test("escapes an embedded single quote", () => {
    expect(hydraQuote("o'brien")).toBe("'o\\'brien'");
  });
});

describe("buildTrainingArgs — Hydra override safety", () => {
  test("REGRESSION: default run name's `.n=<count>` suffix is quoted, not bare", () => {
    // A bare `trainer_config.run_name=250818_143022.centroid.n=13` makes Hydra
    // throw `mismatched input '=' expecting <EOF>` — the crash that blocked the
    // tutorial's Train step for every project with labeled frames.
    const args = buildTrainingArgs(base);
    expect(args).toContain(
      "trainer_config.run_name='250818_143022.centroid.n=13'",
    );
    // ...and never the unquoted form.
    expect(args).not.toContain(
      "trainer_config.run_name=250818_143022.centroid.n=13",
    );
  });

  test("labels path is a quoted Hydra list element", () => {
    expect(buildTrainingArgs(base)).toContain(
      "data_config.train_labels_path=['/Users/a/flies.slp']",
    );
  });

  test("a project path containing '=' is quoted so the path overrides survive", () => {
    const args = buildTrainingArgs({
      ...base,
      labelsPath: "/Users/a/exp=2/flies.slp",
      ckptDir: "/Users/a/exp=2/models",
    });
    expect(args).toContain(
      "data_config.train_labels_path=['/Users/a/exp=2/flies.slp']",
    );
    expect(args).toContain("trainer_config.ckpt_dir='/Users/a/exp=2/models'");
  });

  test("no override value contains a bare (unquoted) second '='", () => {
    // Every override is `key=value`; the value must never itself contain an
    // unquoted `=`. Anything after the first `=` that has another `=` must be
    // inside quotes.
    for (const a of buildTrainingArgs(base)) {
      const eq = a.indexOf("=");
      if (eq === -1) continue; // flags like `--config-name`
      const value = a.slice(eq + 1);
      if (value.includes("=")) {
        expect(value.startsWith("'") || value.startsWith("[")).toBe(true);
      }
    }
  });

  test("ZMQ ports are emitted as bare numbers (no quoting)", () => {
    const args = buildTrainingArgs(base);
    expect(args).toContain("trainer_config.zmq.controller_port=9000");
    expect(args).toContain("trainer_config.zmq.publish_port=9001");
  });

  test("preserves the fixed leading argv (subcommand + config flags)", () => {
    const args = buildTrainingArgs(base);
    expect(args.slice(0, 5)).toEqual([
      "train",
      "--config-name",
      "sleap_train_config_123.yaml",
      "--config-dir",
      "/tmp",
    ]);
  });
});
