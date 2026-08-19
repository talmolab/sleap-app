/**
 * Pure builder for the `sleap-nn train` CLI argv.
 *
 * Kept free of any Tauri / store imports so it is unit-testable in isolation
 * (see tests/unit/trainingArgs.test.ts). `runTraining` in ./backend.ts resolves
 * the runtime-only bits (temp paths, generated run name) and delegates the argv
 * assembly here — mirroring the `buildInferenceArgs` split in ./inferenceArgs.ts.
 *
 * Why the quoting matters: sleap-nn reads its config through Hydra, whose CLI
 * override grammar is `key=value` and rejects a bare second `=` in the value
 * with `OverrideParseException: mismatched input '=' expecting <EOF>`. The
 * default run name copies legacy SLEAP's `.n=<num_user_labeled_frames>` suffix
 * (e.g. `250818_143022.centroid.n=13`), so EVERY default-named run on a project
 * with labeled frames used to crash training at Hydra parse time. A project path
 * containing `=` would break the path overrides the same way. We therefore wrap
 * every interpolated string value in Hydra's single-quoted-string form (escaping
 * any embedded single quote), so arbitrary run names and paths pass through
 * verbatim. Numeric ports need no quoting.
 */

/**
 * Quote a value for use inside a Hydra CLI override so that `=`, spaces, commas,
 * brackets, etc. are treated as literal characters rather than grammar tokens.
 * The surrounding single quotes are literal argv characters (no shell is
 * involved — args are passed directly to the process), which Hydra strips when
 * it parses the quoted string. Embedded single quotes are backslash-escaped,
 * which Hydra's quoted-string grammar accepts.
 */
export function hydraQuote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

export interface BuildTrainingArgsOptions {
  /** Config filename (relative to `configDir`), passed via `--config-name`. */
  configFileName: string;
  /** Directory holding the config file, passed via `--config-dir`. */
  configDir: string;
  /** Path to the training labels .slp (project file or serialized temp copy). */
  labelsPath: string;
  /**
   * Run name for this model. Typically `{timestamp}.{head}.n={count}` — the
   * `.n=` suffix is exactly why the value must be quoted (see module docs).
   */
  runName: string;
  /** Checkpoint output directory (the run folder is `ckptDir/runName`). */
  ckptDir: string;
  /** ZMQ controller port (stop commands). Defaults to 9000. */
  controllerPort?: number;
  /** ZMQ publish port (progress). Defaults to 9001. */
  publishPort?: number;
}

/**
 * Build the full `sleap-nn train ...` argv (excluding the `sleap-nn` program
 * token itself). Every interpolated string value is Hydra-quoted; ports are
 * emitted as bare numbers.
 */
export function buildTrainingArgs({
  configFileName,
  configDir,
  labelsPath,
  runName,
  ckptDir,
  controllerPort = 9000,
  publishPort = 9001,
}: BuildTrainingArgsOptions): string[] {
  return [
    "train",
    "--config-name",
    configFileName,
    "--config-dir",
    configDir,
    // train_labels_path is a Hydra list — quote the element, not the brackets.
    `data_config.train_labels_path=[${hydraQuote(labelsPath)}]`,
    `trainer_config.run_name=${hydraQuote(runName)}`,
    `trainer_config.ckpt_dir=${hydraQuote(ckptDir)}`,
    `trainer_config.zmq.controller_port=${controllerPort}`,
    `trainer_config.zmq.publish_port=${publishPort}`,
  ];
}
