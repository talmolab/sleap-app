/**
 * Diagnostics bundle assembler.
 *
 * Gathers what the app already keeps in memory (the console session trace, the
 * notification/toast buffer, training/inference subprocess output, environment
 * facts) plus the durable session logs, and serializes them into a single
 * self-describing object a tester can save and send us to reproduce a bug.
 *
 * NO video frames are ever included. Project file paths and coarse stats are
 * always included; the tester's actual labels (imageless — skeleton + point
 * coordinates, no images) are included only when `includeProject` is set.
 *
 * The pure {@link assembleDiagnosticsBundle} / {@link inferTutorialStage} are
 * unit-tested; {@link collectDiagnostics} is the thin live gatherer.
 */

import { getLogEntries, type LogEntry } from "@/components/panels/DebugPanel";
import {
  notificationBuffer,
  type NotificationEntry,
} from "@/lib/notificationStore";
import {
  getBootTimestamp,
  getInstallId,
  getSessionId,
  readSessionLogs,
} from "./sessionLog";
import { isTauri } from "@/lib/platform";

export interface ProjectStats {
  stage: string;
  path: string | null;
  videoCount: number;
  skeletonNodeCount: number;
  userLabeledFrameCount: number;
  predictedInstanceCount: number;
  trackCount: number;
}

export interface DiagnosticsMeta {
  installId: string;
  sessionId: string;
  bootTimestamp: string;
  collectedTimestamp: string;
  appName: string;
  appVersion: string;
  userAgent: string;
  runtime: "tauri" | "browser";
  gpu: string | null;
  uv: unknown;
  python: unknown;
  sleapNnVersion: string | null;
  project: ProjectStats;
}

export interface DiagnosticsBundle {
  _whatIsThis: string;
  meta: DiagnosticsMeta;
  sessionLogs: { name: string; content: string }[];
  consoleBuffer: LogEntry[];
  notifications: NotificationEntry[];
  trainingLog: string[];
  inferenceLog: string[];
  draftManifest: unknown[];
  projectDraft: { filename: string; base64: string } | null;
}

export type AssembleInputs = Omit<DiagnosticsBundle, "_whatIsThis">;

const WHAT_IS_THIS =
  "SLEAP Label diagnostics bundle. Contains a session trace (console log), " +
  "in-app notifications, training/inference subprocess output, environment " +
  "info, and project metadata so the SLEAP team can reproduce a bug. It does " +
  "NOT contain video frames. It includes your project's file paths, and — only " +
  "if you opted in — your imageless labels (skeleton + point coordinates, no images).";

/** Coarse tutorial-stage inference from project state (pure). */
export function inferTutorialStage(s: {
  videoCount: number;
  skeletonNodeCount: number;
  userLabeledFrameCount: number;
  predictedInstanceCount: number;
  trackCount: number;
}): string {
  if (s.videoCount === 0) return "empty-project";
  if (s.skeletonNodeCount === 0) return "video-added";
  if (s.userLabeledFrameCount === 0) return "skeleton-built";
  if (s.predictedInstanceCount === 0) return "labeling";
  if (s.trackCount > 0) return "tracking-proofreading";
  return "predictions";
}

/** Pure assembly — combines gathered inputs into the final bundle object. */
export function assembleDiagnosticsBundle(
  inputs: AssembleInputs,
): DiagnosticsBundle {
  return { _whatIsThis: WHAT_IS_THIS, ...inputs };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Gather a live diagnostics bundle from the running app. Every source is
 * read best-effort; a failure in one section leaves that section empty rather
 * than aborting the whole collection.
 */
export async function collectDiagnostics(opts: {
  includeProject: boolean;
}): Promise<DiagnosticsBundle> {
  const { useAppStore } = await import("@/stores/appStore");
  const { useTrainingStore } = await import("@/stores/trainingStore");
  const { useInferenceStore } = await import("@/stores/inferenceStore");
  const { useEnvironmentStore } = await import("@/stores/environmentStore");
  const { countUserLabeledFrames } = await import("@/stores/trainingStore");

  const app = useAppStore.getState();
  const env = useEnvironmentStore.getState();
  const labels = app.labels;

  // --- project stats (best-effort) ---
  const stats: ProjectStats = {
    stage: "unknown",
    path: app.projectPath ?? null,
    videoCount: 0,
    skeletonNodeCount: app.skeleton?.nodes?.length ?? 0,
    userLabeledFrameCount: 0,
    predictedInstanceCount: 0,
    trackCount: 0,
  };
  try {
    if (labels) {
      stats.videoCount = labels.videos?.length ?? 0;
      stats.trackCount = labels.tracks?.length ?? 0;
      stats.userLabeledFrameCount = countUserLabeledFrames(labels) ?? 0;
      const { PredictedInstance } = await import("@talmolab/sleap-io.js");
      let predicted = 0;
      for (const lf of labels.labeledFrames ?? []) {
        for (const inst of lf.instances ?? []) {
          if (inst instanceof PredictedInstance) predicted++;
        }
      }
      stats.predictedInstanceCount = predicted;
    }
  } catch {
    /* leave partial stats */
  }
  stats.stage = inferTutorialStage(stats);

  // --- app + platform identity ---
  let appName = "sleap-app";
  let appVersion = "unknown";
  try {
    const appApi = await import("@tauri-apps/api/app");
    appName = await appApi.getName();
    appVersion = await appApi.getVersion();
  } catch {
    /* browser or unavailable */
  }

  // --- GPU (best-effort; fresh detect) ---
  let gpu: string | null = null;
  try {
    if (isTauri) {
      const { detectGpu } = await import("@/platform/backend");
      const g = await detectGpu();
      gpu = typeof g === "string" ? g : JSON.stringify(g);
    }
  } catch {
    /* ignore */
  }

  // Environment versions (uv + sleap-nn). The tester may never have opened the
  // Environment panel this session, leaving the store fields empty — so detect
  // fresh at collect-time (best-effort). Training/env bugs are the highest-risk
  // area, so these versions are worth the extra couple of seconds.
  let uv: unknown = env.uv ?? null;
  const python: unknown = env.pythonCheck ?? null;
  let sleapNnVersion: string | null = env.pythonCheck?.sleapNnVersion ?? null;
  if (isTauri && (!uv || sleapNnVersion == null)) {
    try {
      const { detectUv, listUvTools } = await import("@/platform/backend");
      if (!uv) {
        try {
          uv = await detectUv();
        } catch {
          /* ignore */
        }
      }
      if (sleapNnVersion == null) {
        try {
          const nn = (await listUvTools()).find((t) => t.name === "sleap-nn");
          if (nn?.version) sleapNnVersion = nn.version;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const meta: DiagnosticsMeta = {
    installId: getInstallId(),
    sessionId: getSessionId(),
    bootTimestamp: new Date(getBootTimestamp() || Date.now()).toISOString(),
    collectedTimestamp: new Date().toISOString(),
    appName,
    appVersion,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    runtime: isTauri ? "tauri" : "browser",
    gpu,
    uv,
    python,
    sleapNnVersion,
    project: stats,
  };

  // --- durable session logs + draft manifest ---
  const sessionLogs = await readSessionLogs();
  let draftManifest: unknown[] = [];
  try {
    if (isTauri) {
      const { listTauriDraftEntries } = await import("@/lib/tauriDraft");
      draftManifest = await listTauriDraftEntries();
    }
  } catch {
    /* ignore */
  }

  // --- opt-in imageless project draft ---
  let projectDraft: { filename: string; base64: string } | null = null;
  if (opts.includeProject && labels) {
    try {
      const { serializeLabelsDraft } = await import("@/lib/labelsDraft");
      const bytes = await serializeLabelsDraft(labels);
      const base = app.projectPath
        ? app.projectPath.replace(/^.*[/\\]/, "")
        : "project";
      projectDraft = { filename: `${base}.imageless.slp`, base64: toBase64(bytes) };
    } catch {
      projectDraft = null;
    }
  }

  return assembleDiagnosticsBundle({
    meta,
    sessionLogs,
    consoleBuffer: [...getLogEntries()],
    notifications: [...notificationBuffer],
    trainingLog: [...(useTrainingStore.getState().log ?? [])],
    inferenceLog: [...(useInferenceStore.getState().log ?? [])],
    draftManifest,
    projectDraft,
  });
}
