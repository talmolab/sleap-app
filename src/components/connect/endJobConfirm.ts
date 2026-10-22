import type { ConfirmRequest } from "@/stores/confirmStore";

/**
 * The confirm dialog for ending a worker job, shared by the Jobs tab and the
 * job viewer. Like SLEAP's training monitor: Stop Early finishes training and
 * keeps the model trained so far; Cancel ends the job without one.
 */
export function endJobConfirm(
  title: string,
  mode: "cancel" | "stop",
  queued: boolean,
): ConfirmRequest {
  if (mode === "stop") {
    return {
      title: "Stop training early?",
      message: `"${title}" finishes its current batch and keeps the model trained so far.`,
      confirmLabel: "Stop Early",
      cancelLabel: "Keep training",
    };
  }
  return {
    title: "Cancel job?",
    message: queued
      ? `"${title}" is removed from the worker's queue and won't run.`
      : `"${title}" ends now without a result.`,
    confirmLabel: "Cancel job",
    cancelLabel: queued ? "Keep queued" : "Keep running",
    destructive: true,
  };
}
