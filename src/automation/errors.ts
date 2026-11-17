/**
 * Errors a Claude-connector (automation) tool returns. `code` is stable for
 * callers; `message` is written for the model (and the user) to read, and
 * says what to do next where there is something to do.
 */
export type AutomationErrorCode =
  | "NO_PROJECT"
  | "NO_QC_RUN"
  | "QC_RUNNING"
  | "UNKNOWN_FLAG"
  | "UNKNOWN_RENDER"
  | "UNKNOWN_PROPOSAL"
  | "UNKNOWN_TOOL"
  | "BAD_INPUT"
  | "OUTDATED"
  | "NOT_PENDING"
  | "RENDER_FAILED";

export class AutomationError extends Error {
  readonly code: AutomationErrorCode;
  constructor(code: AutomationErrorCode, message: string) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
  }
}
