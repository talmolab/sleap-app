/**
 * The event catalog: every event this app can send, and exactly what each
 * carries. `track()` is typed against this map, so an event that is not
 * listed here does not compile.
 *
 * THIS FILE IS THE DISCLOSURE. `docs/usage-data.md` describes these events to
 * users in plain language; if you add an event or a property, update that page
 * in the same change. What must never appear here, in any event:
 *
 *   - file names, paths, URLs, video names, project names
 *   - skeleton node names, track names, anything the user typed
 *   - label data, images, coordinates
 *   - a computer name, user name, or account
 *
 * Counts describing a project are sent as coarse buckets (`bucket()` in
 * protocol.ts), never exact numbers.
 */

/** Stage of work a project is at when opened (same rule as the diagnostics bundle). */
export type ProjectStage =
  | "empty-project"
  | "video-added"
  | "skeleton-built"
  | "labeling"
  | "predictions"
  | "tracking-proofreading";

/**
 * How a training or inference run ended. `stopped` is training's "Stop Early",
 * which keeps the model trained so far; `cancelled` discards the run.
 */
export type RunOutcome = "completed" | "error" | "stopped" | "cancelled";

/** Coarse reason a training or inference run failed (fixed vocabulary, never raw stderr). */
export type RunErrorCategory =
  | "oom"
  | "cuda"
  | "missing_env"
  | "validation"
  | "network"
  | "other";

/** Coarse video reader backend family for an opened project. */
export type VideoBackendKind =
  | "media"
  | "avi"
  | "hdf5"
  | "image"
  | "seq"
  | "mixed"
  | "none"
  | "other";

export interface AnalyticsEvents {
  /** Once per app window, when it starts. */
  session_start: {
    /** No prior analytics session had been sent from this storage profile. */
    first_run: boolean;
    /** The previous session ended without a clean shutdown (desktop primary window only). */
    prior_crash: boolean;
    /** True for the primary (cold-launch) window and browser; false for desktop sibling windows. */
    primary_window?: boolean;
  };

  /**
   * Sent with each periodic batch. There is no reliable "the app closed"
   * moment (a crash, a force-quit and a closed tab all skip it), so session
   * length is read from the last heartbeat that arrived.
   */
  heartbeat: {
    /** Seconds since the window started. */
    uptime_s: number;
    /** Seconds the window was visible. */
    active_s: number;
  };

  /**
   * How many times each menu item, command, or sidebar panel ran since the last
   * `usage` event. Keys are `m:<menu id>` (e.g. `m:file.save`), `c:<command name>`
   * (e.g. `c:AddInstance`), and `p:<panel id>` (e.g. `p:qc`) — identifiers
   * defined in this codebase, never user data.
   */
  usage: Record<string, number>;

  /** A project was opened or created. Sizes are buckets ("6-20", "101-500"). */
  project_opened: {
    stage: ProjectStage;
    videos: string;
    labeled_frames: string;
    predicted_instances: string;
    tracks: string;
    skeleton_nodes: string;
    /** Video backend family decoding the project's videos. */
    video_backend?: VideoBackendKind;
  };

  training_started: {
    /** Trained on a remote worker (Connect) rather than this machine. */
    remote: boolean;
    /** Number of models in the run (2 for top-down). */
    models: number;
    /** Model architecture family, e.g. `top_down`, `bottom_up`, `bbox`. */
    model_type?: string;
  };

  training_finished: {
    outcome: RunOutcome;
    remote: boolean;
    models: number;
    duration_s: number;
    /** Epochs completed, summed over the run's models. */
    epochs: number;
    /** Model architecture family, e.g. `top_down`, `bottom_up`, `bbox`. */
    model_type?: string;
    /** Coarse failure category when `outcome === "error"`. */
    error_category?: RunErrorCategory | null;
  };

  inference_started: {
    /** Ran on a remote worker (Connect) rather than this machine. */
    remote?: boolean;
  };

  inference_finished: {
    outcome: RunOutcome;
    duration_s: number;
    /** Ran on a remote worker (Connect) rather than this machine. */
    remote?: boolean;
    /** Coarse failure category when `outcome === "error"`. */
    error_category?: RunErrorCategory | null;
  };

  /** A remote-worker (Connect) connection attempt succeeded or failed. */
  connect_worker: {
    /** Transport route used, e.g. `ws` or `iroh`. */
    transport: string;
    outcome: "connected" | "error";
  };

  /**
   * An uncaught error, an unhandled promise rejection, or a render crash.
   * `message` and `stack` have paths, filenames, URLs and email addresses
   * removed (`scrubText` / `summarizeStack` in protocol.ts) before they are
   * stored. Repeats within a session are counted, not re-sent.
   */
  error: {
    kind: "uncaught" | "unhandledrejection" | "render";
    /** Groups occurrences of the same error across users and versions. */
    fp: string;
    message: string;
    stack: string;
    /** Occurrences of this fingerprint in this session, including this one. */
    count: number;
    /** The last command that ran before the error, e.g. `c:AddInstance`. */
    after: string | null;
  };

  /** The getting-started tutorial was started, finished, or left early. */
  tutorial: {
    action: "started" | "completed" | "exited";
    /** Furthest step reached (0-based). */
    step: number;
    steps: number;
  };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/**
 * Events worth sending within seconds rather than at the next periodic flush:
 * the ones that are lost entirely if the app then crashes or is closed.
 */
export const PROMPT_EVENTS: ReadonlySet<AnalyticsEventName> = new Set<AnalyticsEventName>([
  "session_start",
  "error",
  "training_finished",
  "inference_finished",
]);
