/**
 * Label QC Detector Settings and the issue-type filter.
 *
 * Detector Settings turn each check on or off and set its thresholds, per
 * project on this computer (like Ignore marks: never in the .slp). Two kinds:
 *  - live: on/off toggles and the anomaly threshold. They filter the current
 *    results right away, so no rerun is needed.
 *  - run: the other thresholds (GMM share, L/R flip fraction, duplicate IoU,
 *    chain-order turn angle and fraction, sparse node count). They change what
 *    a run finds, so they apply on the next Run.
 *
 * The issue-type filter hides flags by their issue (e.g. "Duplicate",
 * "Unusual joint angle") for the session. It is not saved.
 *
 * Everything that shows QC results (the dialog, the panel, the Review window,
 * the canvas boxes, F / Shift+F) goes through `filterQcResults`, so they all
 * agree on what is flagged.
 */
import { QC_KIND_LABEL, type QcFinding, type QcIssueKind } from "@/lib/analyze/labelQc";
import { anomalyVerdict, type AnomalyResult, type AnomalyVerdict } from "./anomaly";

export type QcDetectorId = "anomaly" | "gmm" | QcIssueKind;

export interface QcSettings {
  enabled: Record<QcDetectorId, boolean>;
  /** Anomaly score at which an instance is flagged (live; the threshold slider). */
  anomalyThreshold: number;
  /** GMM flags the least typical this-many percent of poses (run). */
  gmmPercent: number;
  /** Share of symmetric pairs that must look flipped (run). */
  chiralityThreshold: number;
  /** Bounding-box overlap (IoU) at which two instances are duplicates (run). */
  duplicateIou: number;
  /** Turn along a chain, in degrees, that counts as out of order (run). */
  chainTurnDeg: number;
  /** Share of a chain's turns that must be out of order (run). */
  chainInversion: number;
  /** Instances with fewer visible nodes than this are sparse (run). */
  minVisibleNodes: number;
}

/** The order detectors are listed in, and every id. */
export const QC_DETECTOR_IDS: readonly QcDetectorId[] = [
  "anomaly",
  "gmm",
  "chirality",
  "duplicate",
  "chain_order",
  "out_of_range",
  "empty_instance",
  "sparse_instance",
  "incomplete_frame",
  "negative_frame",
];

export const DEFAULT_QC_SETTINGS: QcSettings = Object.freeze({
  enabled: Object.freeze(
    Object.fromEntries(QC_DETECTOR_IDS.map((id) => [id, true])) as Record<QcDetectorId, boolean>,
  ),
  anomalyThreshold: 0.7,
  gmmPercent: 5,
  chiralityThreshold: 0.5,
  duplicateIou: 0.5,
  chainTurnDeg: 60,
  chainInversion: 0.3,
  minVisibleNodes: 2,
}) as QcSettings;

/** Numeric settings, with their allowed range and step. */
export const QC_SETTING_RANGES = {
  anomalyThreshold: { min: 0, max: 1, step: 0.01 },
  gmmPercent: { min: 1, max: 50, step: 1 },
  chiralityThreshold: { min: 0.05, max: 1, step: 0.05 },
  duplicateIou: { min: 0.05, max: 1, step: 0.05 },
  chainTurnDeg: { min: 10, max: 150, step: 5 },
  chainInversion: { min: 0.05, max: 1, step: 0.05 },
  minVisibleNodes: { min: 1, max: 20, step: 1 },
} as const satisfies Record<Exclude<keyof QcSettings, "enabled">, { min: number; max: number; step: number }>;

export type QcNumericSetting = keyof typeof QC_SETTING_RANGES;

/** Settings that change what a run finds, so they apply on the next Run. */
export const QC_RUN_SETTINGS: readonly QcNumericSetting[] = [
  "gmmPercent",
  "chiralityThreshold",
  "duplicateIou",
  "chainTurnDeg",
  "chainInversion",
  "minVisibleNodes",
];

/** Whether any run setting differs, i.e. a Rerun would find something different. */
export function runSettingsDiffer(a: QcSettings, b: QcSettings): boolean {
  return QC_RUN_SETTINGS.some((k) => a[k] !== b[k]);
}

const clamp = (k: QcNumericSetting, v: unknown, fallback: number): number => {
  const { min, max } = QC_SETTING_RANGES[k];
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

/** Any stored value as valid settings: unknown keys dropped, missing or bad ones defaulted. */
export function sanitizeQcSettings(raw: unknown): QcSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof QcSettings, unknown>>;
  const en = (r.enabled && typeof r.enabled === "object" ? r.enabled : {}) as Record<string, unknown>;
  const enabled = Object.fromEntries(
    QC_DETECTOR_IDS.map((id) => [id, typeof en[id] === "boolean" ? en[id] : true]),
  ) as Record<QcDetectorId, boolean>;
  const out = { enabled } as QcSettings;
  for (const k of Object.keys(QC_SETTING_RANGES) as QcNumericSetting[])
    out[k] = clamp(k, r[k], DEFAULT_QC_SETTINGS[k]);
  return out;
}

// ── Issue types ──

/** The issue type of a rule finding: its check's name. */
export const qcFindingIssueType = (f: QcFinding): string => QC_KIND_LABEL[f.kind];

/**
 * The issue type of a flagged instance: its issue without the detail, so
 * "Improbable pose · Unusual joint angle" is "Improbable pose" and
 * "Unusual edge length (increased)" is "Unusual edge length".
 */
export const qcVerdictIssueType = (v: AnomalyVerdict): string =>
  v.issue.split(" · ")[0].replace(/ \((?:in|de)creased\)$/, "");

/** Results as every view shows them (see `filterQcResults`). */
export interface QcView {
  findings: QcFinding[];
  anomaly: AnomalyResult | null;
  /** Effective anomaly threshold (Infinity when the anomaly score is off). */
  threshold: number;
}

/**
 * The results with switched-off detectors and hidden issue types left out.
 * The anomaly result keeps every instance that isn't flagged (for its scores
 * and CSV) and its GMM threshold is null when the GMM is off, so
 * `anomalyVerdict(a, view.threshold, view.anomaly.gmmThreshold)` is the
 * verdict everywhere.
 */
export function filterQcResults(
  findings: QcFinding[],
  anomaly: AnomalyResult | null,
  settings: QcSettings,
  hiddenIssues: ReadonlySet<string> = new Set(),
): QcView {
  const { enabled } = settings;
  const threshold = enabled.anomaly ? settings.anomalyThreshold : Infinity;
  const kept = findings.filter(
    (f) => enabled[f.kind] !== false && !hiddenIssues.has(qcFindingIssueType(f)),
  );
  let view = anomaly;
  if (anomaly) {
    const gmmThreshold = enabled.gmm ? anomaly.gmmThreshold : null;
    const instances =
      hiddenIssues.size === 0
        ? anomaly.instances
        : anomaly.instances.filter((a) => {
            const v = anomalyVerdict(a, threshold, gmmThreshold);
            return !v.flagged || !hiddenIssues.has(qcVerdictIssueType(v));
          });
    view =
      gmmThreshold === anomaly.gmmThreshold && instances === anomaly.instances
        ? anomaly
        : { ...anomaly, gmmThreshold, instances };
  }
  return {
    findings: kept.length === findings.length ? findings : kept,
    anomaly: view,
    threshold,
  };
}

export interface QcIssueTypeCount {
  type: string;
  /** "rule" for rule checks, "pose" for the anomaly/GMM scores. */
  group: "rule" | "pose";
  count: number;
}

/**
 * The issue types flagged under these settings (ignoring the issue filter),
 * with how many flags each has: rule checks first, in the checks' order, then
 * pose issues, most common first. For the issue-type filter's menu.
 */
export function qcIssueTypes(
  findings: QcFinding[],
  anomaly: AnomalyResult | null,
  settings: QcSettings,
): QcIssueTypeCount[] {
  const view = filterQcResults(findings, anomaly, settings);
  const rules = new Map<string, number>();
  for (const f of view.findings) {
    const t = qcFindingIssueType(f);
    rules.set(t, (rules.get(t) ?? 0) + 1);
  }
  const pose = new Map<string, number>();
  for (const a of view.anomaly?.instances ?? []) {
    const v = anomalyVerdict(a, view.threshold, view.anomaly?.gmmThreshold ?? null);
    if (!v.flagged) continue;
    const t = qcVerdictIssueType(v);
    pose.set(t, (pose.get(t) ?? 0) + 1);
  }
  const ruleOrder = Object.values(QC_KIND_LABEL);
  return [
    ...[...rules]
      .sort(([x], [y]) => ruleOrder.indexOf(x) - ruleOrder.indexOf(y))
      .map(([type, count]) => ({ type, group: "rule" as const, count })),
    ...[...pose]
      .sort(([x, a], [y, b]) => b - a || x.localeCompare(y))
      .map(([type, count]) => ({ type, group: "pose" as const, count })),
  ];
}

// ── Persistence (per project, on this computer) ──

const STORAGE_KEY = "sleap-app.qcSettings";
/** Projects whose settings are kept (most recently changed first out). */
export const MAX_QC_SETTINGS_PROJECTS = 50;

function readAll(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A project's settings, or the defaults when it has none. */
export function loadQcSettings(projectKey: string): QcSettings {
  const all = readAll();
  return projectKey in all ? sanitizeQcSettings(all[projectKey]) : sanitizeQcSettings(null);
}

/**
 * Save a project's settings. Settings equal to the defaults remove its entry,
 * so untouched projects take no space. Never throws.
 */
export function saveQcSettings(projectKey: string, settings: QcSettings): void {
  try {
    const { [projectKey]: _old, ...rest } = readAll();
    void _old;
    const isDefault =
      JSON.stringify(sanitizeQcSettings(settings)) === JSON.stringify(sanitizeQcSettings(null));
    const next: Record<string, unknown> = isDefault ? rest : { ...rest, [projectKey]: settings };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_QC_SETTINGS_PROJECTS)))
      delete next[k];
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the settings still apply for this session.
  }
}
