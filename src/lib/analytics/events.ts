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

export interface AnalyticsEvents {
  /** Once per app window, when it starts. */
  session_start: {
    /** No install id existed before this launch. */
    first_run: boolean;
    /** The previous session ended without a clean shutdown (desktop only). */
    prior_crash: boolean;
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
   * How many times each menu item and command ran since the last `usage`
   * event. Keys are `m:<menu id>` (e.g. `m:file.save`) and `c:<command name>`
   * (e.g. `c:AddInstance`) — identifiers defined in this codebase, never user
   * data. This is what tells us which features are used and which are not.
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
  };

  training_started: {
    /** Trained on a remote worker (Connect) rather than this machine. */
    remote: boolean;
    /** Number of models in the run (2 for top-down). */
    models: number;
  };

  training_finished: {
    outcome: RunOutcome;
    remote: boolean;
    models: number;
    duration_s: number;
    /** Epochs completed, summed over the run's models. */
    epochs: number;
  };

  inference_started: Record<string, never>;

  inference_finished: {
    outcome: RunOutcome;
    duration_s: number;
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
