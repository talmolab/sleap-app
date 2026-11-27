/**
 * Live SLP format status inspection and 2.x -> 3.0 upgrade-lifecycle tracking.
 *
 * Keeps all format inspection pure and defensive against partial mocks of
 * `@talmolab/sleap-io.js` in unit tests. Session-scoped WeakSets guarantee that
 * opening a new project starts fresh without storing anything in `appStore`.
 */
import * as sio from "@talmolab/sleap-io.js";
import type {
  Format3Summary,
  Instance,
  Labels,
  RecordMetadata,
  SlpVersion,
  SlpWriteOptions,
} from "@talmolab/sleap-io.js";
import { isUnlabeledPoint, isViewOnlyLabels, metadataOf } from "@/lib/slpFormat";
import { toast } from "@/lib/notify";

/** How unlabeled points are handled when explicitly writing the SLP 2.x layout. */
export type UnlabeledAs = NonNullable<SlpWriteOptions["unlabeledAs"]>;

export interface ProjectFormatStatus {
  /** True when the project was opened from an SLP format 3.0 file. */
  sourceIsFormat3: boolean;
  /** Remembered layout from the last save of this `Labels`, if any. */
  rememberedLayout: "v2" | "v3" | null;
  /** True when the project is currently open View only. */
  viewOnly: boolean;
  /** True when saving with `slpVersion: "auto"` will write SLP format 3.0. */
  willWriteFormat3: boolean;
  /** True when live in-memory data contains SLP 3.0-only features. */
  hasFormat3Content: boolean;
  /**
   * True when a project that did not originate from (and has not yet been
   * saved in) SLP 3.0 now contains format 3.0 features, so the next save will
   * upgrade it from 2.x to 3.0.
   */
  pendingUpgradeFromV2: boolean;
  /** Compact label for the StatusBar format pill. */
  pillLabel: string;
  /** Live feature summary compatible with `describeFormat3Drops`. */
  summary: Format3Summary;
}

function isPredictedInstance(inst: Instance): boolean {
  if (typeof sio.PredictedInstance === "function" && inst instanceof sio.PredictedInstance) {
    return true;
  }
  return inst?.constructor?.name === "PredictedInstance";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function readCarriedUnknownColumns(labels: Labels): string[] {
  const cols = new Set<string>();
  const access = labels.sourceFormat?.access;
  if (access !== "edit") {
    for (const col of labels.sourceFormat?.summary?.unknownColumns ?? []) {
      if (col) cols.add(col);
    }
  }
  const carry = (
    labels as unknown as {
      _carriedColumns?: {
        tables?: Map<string, { columns?: Record<string, unknown> }>;
      };
    }
  )._carriedColumns;
  if (carry?.tables instanceof Map) {
    for (const [table, entry] of carry.tables) {
      const colNames = Object.keys(entry?.columns ?? {});
      if (colNames.length > 0) {
        for (const name of colNames) cols.add(`${table}.${name}`);
      } else {
        cols.add(`/${table}`);
      }
    }
  }
  return [...cols].sort();
}

function readRememberedLayout(labels: Labels): "v2" | "v3" | null {
  const layout = (labels as unknown as { _slpLayout?: unknown })._slpLayout;
  return layout === "v2" || layout === "v3" ? layout : null;
}

function computeWillWriteFormat3(
  labels: Labels,
  sourceIsFormat3: boolean,
  rememberedLayout: "v2" | "v3" | null,
  hasFormat3Content: boolean,
): boolean {
  if (typeof sio.resolveSlpVersion === "function" && typeof sio.Labels === "function" && labels instanceof sio.Labels) {
    try {
      return sio.resolveSlpVersion(labels, "auto", { warn: false }) === "v3";
    } catch {
      // Fall through to structural heuristic if labels is a test stand-in.
    }
  }
  if (rememberedLayout === "v3") return true;
  if (labels.sourceFormat?.access === "edit") return false;
  if (sourceIsFormat3 && rememberedLayout !== "v2") return true;
  return hasFormat3Content;
}

/**
 * Inspect `labels` for its current SLP format state and live format 3.0 features.
 * Safe to call with partial/mocked `Labels` objects in unit tests.
 */
export function inspectProjectFormat(
  labels: Labels | null | undefined,
): ProjectFormatStatus | null {
  if (!labels) return null;

  let unlabeledUserPoints = 0;
  let unlabeledPredictedPoints = 0;
  const frameMetaKeys = new Set<string>();
  const instanceMetaKeys = new Set<string>();
  const bboxMetaKeys = new Set<string>();

  const frames = Array.isArray(labels.labeledFrames) ? labels.labeledFrames : [];
  for (const lf of frames) {
    const fMeta = metadataOf(lf as { metadata?: RecordMetadata | null });
    if (fMeta) {
      for (const k of Object.keys(fMeta)) frameMetaKeys.add(k);
    }

    const instances = Array.isArray(lf.instances) ? lf.instances : [];
    for (const inst of instances) {
      const predicted = isPredictedInstance(inst);
      const pts = Array.isArray(inst.points) ? inst.points : [];
      for (const p of pts) {
        if (isUnlabeledPoint(p)) {
          if (predicted) unlabeledPredictedPoints += 1;
          else unlabeledUserPoints += 1;
        }
      }
      const iMeta = metadataOf(inst as { metadata?: RecordMetadata | null });
      if (iMeta) {
        for (const k of Object.keys(iMeta)) instanceMetaKeys.add(k);
      }
    }

    const bboxes = Array.isArray((lf as { bboxes?: unknown[] }).bboxes)
      ? ((lf as { bboxes?: Array<{ metadata?: RecordMetadata | null }> }).bboxes ?? [])
      : [];
    for (const bbox of bboxes) {
      const bMeta = metadataOf(bbox);
      if (bMeta) {
        for (const k of Object.keys(bMeta)) bboxMetaKeys.add(k);
      }
    }
  }

  const unlabeledPoints = unlabeledUserPoints + unlabeledPredictedPoints;
  const instancesKeys = [...instanceMetaKeys].sort();
  const framesKeys = [...frameMetaKeys].sort();
  const bboxesKeys = [...bboxMetaKeys].sort();
  const unknownColumns = readCarriedUnknownColumns(labels);
  const unreadTables = [...(labels.sourceFormat?.summary?.unreadTables ?? [])];

  const sourceIsFormat3 = (labels.sourceFormat?.formatId ?? 0) >= 3;
  const rememberedLayout = readRememberedLayout(labels);
  const viewOnly = isViewOnlyLabels(labels);
  const hasFormat3Content =
    unlabeledPoints > 0 ||
    instancesKeys.length > 0 ||
    framesKeys.length > 0 ||
    bboxesKeys.length > 0 ||
    unknownColumns.length > 0;

  const willWriteFormat3 = computeWillWriteFormat3(
    labels,
    sourceIsFormat3,
    rememberedLayout,
    hasFormat3Content,
  );
  const pendingUpgradeFromV2 =
    !viewOnly && !sourceIsFormat3 && rememberedLayout !== "v3" && willWriteFormat3;

  const pillLabel = viewOnly
    ? "SLP 3.0 · View only"
    : pendingUpgradeFromV2
      ? "SLP 3.0 (pending save)"
      : willWriteFormat3
        ? "SLP 3.0"
        : "SLP 2.x";

  const summary: Format3Summary = {
    formatId: 3,
    unlabeledPoints,
    unlabeledUserPoints,
    unlabeledPredictedPoints,
    metadataKeys: {
      instances: instancesKeys,
      frames: framesKeys,
      bboxes: bboxesKeys,
    },
    unknownColumns,
    unreadTables,
    lossless: false,
  };

  return {
    sourceIsFormat3,
    rememberedLayout,
    viewOnly,
    willWriteFormat3,
    hasFormat3Content,
    pendingUpgradeFromV2,
    pillLabel,
    summary,
  };
}

/**
 * Human-readable list of active format 3.0 features present in `summary`.
 * Used in the StatusBar popover and the 2.x -> 3.0 upgrade confirmation dialog.
 */
export function describeFormat3Features(summary: Format3Summary): string[] {
  const items: string[] = [];
  if (summary.unlabeledPoints > 0) {
    const parts: string[] = [];
    if (summary.unlabeledUserPoints > 0) {
      parts.push(`${summary.unlabeledUserPoints} in user instances`);
    }
    if (summary.unlabeledPredictedPoints > 0) {
      parts.push(`${summary.unlabeledPredictedPoints} in predictions`);
    }
    items.push(
      `${plural(summary.unlabeledPoints, "unlabeled node", "unlabeled nodes")}` +
        (parts.length > 0 ? ` (${parts.join(", ")})` : ""),
    );
  }
  const tables: Array<[keyof Format3Summary["metadataKeys"], string]> = [
    ["instances", "Instance metadata"],
    ["frames", "Frame metadata"],
    ["bboxes", "Bounding box metadata"],
  ];
  for (const [table, label] of tables) {
    const keys = summary.metadataKeys?.[table] ?? [];
    if (keys.length > 0) items.push(`${label}: ${keys.join(", ")}`);
  }
  if (summary.unknownColumns.length > 0) {
    items.push(`Carried unknown columns: ${summary.unknownColumns.join(", ")}`);
  }
  const unread = summary.unreadTables ?? [];
  if (unread.length > 0) {
    items.push(`Unread format 3.0 tables: ${unread.join(", ")}`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// One-time per-project upgrade toast & save confirmation tracking
// ---------------------------------------------------------------------------

const notifiedUpgradeToast = new WeakSet<object>();
const confirmedUpgradeSave = new WeakSet<object>();

/**
 * Show a one-time non-blocking info toast when a 2.x project first acquires
 * SLP 3.0-only data during an editing session. Returns `true` if fired.
 */
export function maybeNotifyFormat3Upgrade(
  labels: Labels | null | undefined,
  status: ProjectFormatStatus | null,
): boolean {
  if (!labels || !status?.pendingUpgradeFromV2) return false;
  if (notifiedUpgradeToast.has(labels)) return false;
  notifiedUpgradeToast.add(labels);
  toast.info("Project will save as SLP 3.0", {
    description:
      "Unlabeled nodes or metadata require SLP 3.0 (SLEAP 0.2+ / sleap-io >= 0.10). " +
      "Use File ▸ Export ▸ SLP Copy… to save an SLP 2.x copy.",
  });
  return true;
}

/**
 * Whether overwriting an existing on-disk 2.x project file needs a one-time
 * confirmation dialog before upgrading it to SLP 3.0.
 */
export function needsFormat3UpgradeConfirm(
  labels: Labels | null | undefined,
  hasExistingOnDiskTarget: boolean,
): boolean {
  if (!labels || !hasExistingOnDiskTarget) return false;
  if (confirmedUpgradeSave.has(labels)) return false;
  return inspectProjectFormat(labels)?.pendingUpgradeFromV2 ?? false;
}

/** Record that the user confirmed upgrading `labels` to SLP 3.0 this session. */
export function markFormat3UpgradeConfirmed(labels: Labels | null | undefined): void {
  if (!labels) return;
  confirmedUpgradeSave.add(labels);
  notifiedUpgradeToast.add(labels);
}

/** Reset session upgrade-notification state for `labels` (intended for tests). */
export function resetFormat3UpgradeTracking(labels: Labels | null | undefined): void {
  if (!labels) return;
  notifiedUpgradeToast.delete(labels);
  confirmedUpgradeSave.delete(labels);
}

// ---------------------------------------------------------------------------
// Shared defaults & filename helpers
// ---------------------------------------------------------------------------

/**
 * Smart default for unmapped nodes added to existing instances: `"unlabeled"`
 * when the project already targets SLP 3.0, `"absent"` on SLP 2.x projects so
 * adding a node does not unexpectedly upgrade a 2.x project unless chosen.
 */
export function defaultUnmappedForLabels(
  labels: Labels | null | undefined,
): "unlabeled" | "absent" {
  return inspectProjectFormat(labels)?.willWriteFormat3 ? "unlabeled" : "absent";
}

/**
 * Suggest a copy filename for File ▸ Export ▸ SLP Copy… so exporting a 2.x
 * copy of a 3.0 project suggests `<stem>.v2.slp` instead of clobbering the
 * master file.
 */
export function deriveSlpCopyFilename(
  filename: string | null | undefined,
  targetVersion: SlpVersion,
  currentlyFormat3: boolean,
): string {
  const base = (filename ?? "labels").trim() || "labels";
  const stem = base.replace(/\.slp$/i, "");
  if (targetVersion === "v2" && currentlyFormat3) return `${stem}.v2.slp`;
  if (targetVersion === "v3" && !currentlyFormat3) return `${stem}.v3.slp`;
  return `${stem}.copy.slp`;
}
