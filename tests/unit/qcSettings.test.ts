/**
 * Label QC Detector Settings and issue-type filter (qc/settings.ts): what
 * each toggle and filter leaves out, the issue types offered, and saving
 * settings per project. Also that runLabelQc honors the run thresholds.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { runLabelQc, type QcFinding } from "@/lib/analyze/labelQc";
import { anomalyVerdict, type AnomalyInstance, type AnomalyResult } from "@/lib/analyze/qc/anomaly";
import {
  DEFAULT_QC_SETTINGS,
  MAX_QC_SETTINGS_PROJECTS,
  filterQcResults,
  loadQcSettings,
  qcIssueTypes,
  qcVerdictIssueType,
  runSettingsDiffer,
  sanitizeQcSettings,
  saveQcSettings,
  type QcSettings,
} from "@/lib/analyze/qc/settings";

const video = {} as QcFinding["video"];
const finding = (frameIdx: number, kind: QcFinding["kind"], instanceIdx: number | undefined = 0): QcFinding => ({
  kind,
  message: kind,
  video,
  videoIdx: 0,
  frameIdx,
  instanceIdx,
});
const scored = (
  frameIdx: number,
  score: number,
  gmmScore: number | null = null,
  topIssue = "Unusual joint angle",
): AnomalyInstance => ({
  videoIdx: 0,
  frameIdx,
  instIdx: 0,
  score,
  confidence: "high",
  topIssue,
  issueNodes: [],
  issueKind: null,
  issueDir: 0,
  contributions: {},
  gmmScore,
  gmmIssue: gmmScore != null && gmmScore >= 0.95 ? "Improbable pose · Unusual edge length" : null,
  gmmNode: null,
});
const result = (instances: AnomalyInstance[]): AnomalyResult => ({ instances, featureNames: [], gmmThreshold: 0.95 });
const withSettings = (
  patch: Partial<Omit<QcSettings, "enabled">> & { enabled?: Partial<QcSettings["enabled"]> } = {},
): QcSettings => ({
  ...DEFAULT_QC_SETTINGS,
  ...patch,
  enabled: { ...DEFAULT_QC_SETTINGS.enabled, ...patch.enabled },
});
/** Instances flagged in a view, by frame. */
const flaggedFrames = (v: ReturnType<typeof filterQcResults>) =>
  (v.anomaly?.instances ?? [])
    .filter((a) => anomalyVerdict(a, v.threshold, v.anomaly?.gmmThreshold ?? null).flagged)
    .map((a) => a.frameIdx);

const findings = [finding(1, "duplicate"), finding(2, "chirality"), finding(3, "incomplete_frame", undefined)];
const anomaly = result([scored(4, 0.9), scored(5, 0.3, 0.97), scored(6, 0.2, 0.1)]);

describe("filterQcResults", () => {
  // With everything on and nothing hidden, the views must see the run's results unchanged.
  it("passes results through untouched by default", () => {
    const v = filterQcResults(findings, anomaly, DEFAULT_QC_SETTINGS);
    expect(v.findings).toBe(findings);
    expect(v.anomaly).toBe(anomaly);
    expect(v.threshold).toBe(0.7);
  });

  // Each rule check's checkbox removes that check's findings, and only those.
  it("leaves out the findings of a rule check that is off", () => {
    const v = filterQcResults(findings, anomaly, withSettings({ enabled: { duplicate: false } }));
    expect(v.findings.map((f) => f.kind)).toEqual(["chirality", "incomplete_frame"]);
  });

  // The anomaly checkbox drops anomaly-score flags but keeps GMM flags.
  it("with the anomaly score off, only the GMM flags", () => {
    const v = filterQcResults(findings, anomaly, withSettings({ enabled: { anomaly: false } }));
    expect(v.threshold).toBe(Infinity);
    expect(flaggedFrames(v)).toEqual([5]);
  });

  // The GMM checkbox drops GMM flags but keeps anomaly-score flags.
  it("with the GMM off, only the anomaly score flags", () => {
    const v = filterQcResults(findings, anomaly, withSettings({ enabled: { gmm: false } }));
    expect(v.anomaly?.gmmThreshold).toBeNull();
    expect(flaggedFrames(v)).toEqual([4]);
  });

  // The anomaly threshold is live: it comes from the settings, not the run.
  it("uses the settings' anomaly threshold", () => {
    expect(flaggedFrames(filterQcResults([], anomaly, withSettings({ anomalyThreshold: 0.25 })))).toEqual([4, 5]);
  });

  // Hiding an issue type hides rule findings and flagged instances of that type,
  // but keeps unflagged instances (their scores still show and export).
  it("hides findings and flagged instances of hidden issue types", () => {
    const v = filterQcResults(findings, anomaly, DEFAULT_QC_SETTINGS, new Set(["Duplicate", "Improbable pose"]));
    expect(v.findings.map((f) => f.kind)).toEqual(["chirality", "incomplete_frame"]);
    expect(v.anomaly?.instances.map((a) => a.frameIdx)).toEqual([4, 6]);
  });
});

describe("issue types", () => {
  // The filter groups flags by issue, without the detail after "·" or the direction.
  it("names a flagged instance's issue type without its detail", () => {
    const gmmOnly = anomalyVerdict(scored(0, 0.1, 0.99), 0.7, 0.95);
    expect(qcVerdictIssueType(gmmOnly)).toBe("Improbable pose");
    const dir = anomalyVerdict(scored(0, 0.9, null, "Unusual edge length (increased)"), 0.7, 0.95);
    expect(qcVerdictIssueType(dir)).toBe("Unusual edge length");
  });

  // The filter menu lists rule checks first, then pose issues, with counts.
  it("lists the flagged issue types with counts, rules first", () => {
    const types = qcIssueTypes([...findings, finding(9, "duplicate")], anomaly, DEFAULT_QC_SETTINGS);
    expect(types).toEqual([
      { type: "Duplicate", group: "rule", count: 2 },
      { type: "Incomplete frame", group: "rule", count: 1 },
      { type: "Chirality (L/R)", group: "rule", count: 1 },
      { type: "Improbable pose", group: "pose", count: 1 },
      { type: "Unusual joint angle", group: "pose", count: 1 },
    ]);
  });

  // A switched-off detector's issue types aren't offered in the filter.
  it("leaves out issue types of switched-off detectors", () => {
    const types = qcIssueTypes(findings, anomaly, withSettings({ enabled: { chirality: false, gmm: false } }));
    expect(types.map((t) => t.type)).toEqual(["Duplicate", "Incomplete frame", "Unusual joint angle"]);
  });
});

describe("settings values", () => {
  // Stored settings may come from an older or hand-edited copy: never trust them.
  it("defaults missing values, clamps out-of-range ones, and drops junk", () => {
    const s = sanitizeQcSettings({
      enabled: { duplicate: false, nonsense: false, gmm: "yes" },
      anomalyThreshold: 5,
      gmmPercent: "x",
      extra: 1,
    });
    expect(s.enabled.duplicate).toBe(false);
    expect(s.enabled.gmm).toBe(true);
    expect("nonsense" in s.enabled).toBe(false);
    expect(s.anomalyThreshold).toBe(1);
    expect(s.gmmPercent).toBe(5);
    expect("extra" in s).toBe(false);
    expect(sanitizeQcSettings(undefined)).toEqual(DEFAULT_QC_SETTINGS);
  });

  // "Rerun to apply" appears only for thresholds that change what a run finds.
  it("tells run thresholds from live ones", () => {
    expect(runSettingsDiffer(DEFAULT_QC_SETTINGS, withSettings({ anomalyThreshold: 0.2 }))).toBe(false);
    expect(runSettingsDiffer(DEFAULT_QC_SETTINGS, withSettings({ enabled: { duplicate: false } }))).toBe(false);
    expect(runSettingsDiffer(DEFAULT_QC_SETTINGS, withSettings({ duplicateIou: 0.8 }))).toBe(true);
  });
});

describe("saving settings per project", () => {
  beforeEach(() => localStorage.clear());

  // Settings belong to one project and come back when it is reopened.
  it("saves and loads each project's settings separately", () => {
    saveQcSettings("/a.slp", withSettings({ gmmPercent: 10, enabled: { chain_order: false } }));
    expect(loadQcSettings("/a.slp")).toMatchObject({ gmmPercent: 10, enabled: { chain_order: false } });
    expect(loadQcSettings("/b.slp")).toEqual(DEFAULT_QC_SETTINGS);
  });

  // Untouched (default) projects take no storage; restoring defaults frees the entry.
  it("stores nothing for default settings", () => {
    saveQcSettings("/a.slp", withSettings({ gmmPercent: 10 }));
    saveQcSettings("/a.slp", DEFAULT_QC_SETTINGS);
    expect(JSON.parse(localStorage.getItem("sleap-app.qcSettings") ?? "{}")).toEqual({});
  });

  // Storage stays bounded: the oldest projects go first.
  it(`keeps at most ${MAX_QC_SETTINGS_PROJECTS} projects`, () => {
    for (let i = 0; i <= MAX_QC_SETTINGS_PROJECTS; i++) saveQcSettings(`/p${i}.slp`, withSettings({ gmmPercent: 10 }));
    expect(loadQcSettings("/p0.slp").gmmPercent).toBe(5);
    expect(loadQcSettings(`/p${MAX_QC_SETTINGS_PROJECTS}.slp`).gmmPercent).toBe(10);
  });

  // A broken stored value must not break QC: fall back to defaults.
  it("falls back to defaults on unreadable storage", () => {
    localStorage.setItem("sleap-app.qcSettings", "{not json");
    expect(loadQcSettings("/a.slp")).toEqual(DEFAULT_QC_SETTINGS);
  });
});

describe("runLabelQc run thresholds", () => {
  const inst = (points: number[][], skeleton?: unknown) => ({ numpy: () => points, skeleton });
  const frame = (instances: unknown[]) => ({ frameIdx: 0, instances, userInstances: instances, isNegative: false });
  const labels = (instances: unknown[]) => ({ videos: [{ shape: null }], find: () => [frame(instances)] }) as never;
  const has = (fs: QcFinding[], kind: QcFinding["kind"]) => fs.some((f) => f.kind === kind);

  // Detector Settings' duplicate IoU reaches the duplicate check (boxes overlap ~0.68).
  it("uses the duplicate IoU threshold", () => {
    const l = labels([inst([[0, 0], [100, 100]]), inst([[10, 10], [110, 110]])]);
    expect(has(runLabelQc(l), "duplicate")).toBe(true);
    expect(has(runLabelQc(l, { duplicateIou: 0.75 }), "duplicate")).toBe(false);
  });

  // The chain-order turn angle and fraction reach the chain check (one ~39° turn of two).
  it("uses the chain-order turn angle and fraction", () => {
    const skel = { edgeIndices: [[0, 1], [1, 2], [2, 3]], nodes: [{}, {}, {}, {}] };
    const l = labels([inst([[0, 0], [1, 0], [2, 0.8], [3, 1.6]], skel)]);
    expect(has(runLabelQc(l), "chain_order")).toBe(false);
    expect(has(runLabelQc(l, { chainTurnDeg: 30 }), "chain_order")).toBe(true);
    expect(has(runLabelQc(l, { chainTurnDeg: 30, chainInversion: 0.6 }), "chain_order")).toBe(false);
  });
});
