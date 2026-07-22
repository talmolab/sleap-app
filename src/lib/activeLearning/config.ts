/**
 * Active-learning loop configuration.
 *
 * The active-learning workflow is entirely config-driven so it is not tied to
 * any one skeleton or organism: the number of rounds, which keypoints belong to
 * each labeling pass, the frame-mining strategies, and the consistency-benchmark
 * settings all live in an `active-learning.yaml`. This module is the pure,
 * React-free, side-effect-free core for that config — parsing, validation, and
 * serialization — so it is fully unit-testable (see issue #212, milestone M0).
 *
 * Parsing is intentionally LENIENT: {@link parseActiveLearningConfig} fills in
 * defaults and coerces types so a partial YAML (only the fields a user wants to
 * override) round-trips into a complete config. Semantic problems — especially
 * pass node names that don't exist in the project's skeleton — are surfaced
 * separately by {@link validateActiveLearningConfig}, which needs the skeleton
 * to check against and so is called at project-load time rather than parse time.
 */

import yaml from "js-yaml";

/** Config schema version this module understands. */
export const ACTIVE_LEARNING_CONFIG_VERSION = 1;

/** Order in which Phase-2 labeling sweeps the crop set. */
export type PassOrder = "pass-major" | "crop-major";

/** Frame-mining strategy names (subset of {@link suggestionStrategies}). */
export type MineStrategy = "prediction_score" | "velocity" | "max_displacement";

/** Loop-level controls. `stopWhen` produces dashboard hints only — never gates. */
export interface LoopConfig {
  maxRounds: number;
  stopWhen: { metricPlateau: boolean };
}

export type LocatorBackbone = "unet" | "convnext" | "swint";

/** Augmentation preset for the locator (rotation is kept since orientation varies). */
export type LocatorAugmentation = "minimal" | "rotation" | "rotation-intensity";

/** Training params for the Phase-1 centroid locator (a fast, retrainable model). */
export interface LocatorTrainingConfig {
  backbone: LocatorBackbone;
  /** Input downscale factor in (0, 1] — 0.5 = half resolution. */
  inputScale: number;
  maxEpochs: number;
  batchSize: number;
  augmentation: LocatorAugmentation;
  /** Stop when the val metric plateaus (drives the "good enough" cue). */
  earlyStop: boolean;
}

/** Phase 1: localize animals (seed centroids → locator → zoom-to-label). */
export interface LocalizeConfig {
  enabled: boolean;
  /**
   * Skeleton node clicked once per animal during centroid seeding + locator
   * anchor. `null` = ARBITRARY centroid: the anchor is a free point (not a pose
   * node), so every pose node is labeled by a pass and the locator's anchor is
   * the instance centroid rather than a named node.
   */
  centroidNode: string | null;
  /**
   * For a FREE centroid anchor (`centroidNode` = "centroid"), where the anchor
   * lives:
   *  - `false`: a synthetic node ADDED to the pose skeleton — simple, but the
   *    pose model would emit it as an extra node.
   *  - `true`: a first-class centroid annotation (`UserCentroid` on
   *    `frame.centroids`), separate from the pose keypoints, so the pose model
   *    never treats it as a keypoint. Phase-2 pairs each centroid with a pose
   *    instance.
   * Ignored when `centroidNode` names a real pose node (NODE mode).
   */
  separateCentroid: boolean;
  /**
   * Default zoom-to-instance window (px) for Phase-2 labeling. NOT a baked crop
   * — Phase-2 zooms the live view to the centroid at this size, adjustable per
   * instance with a slider, so a too-tight setting never clips a keypoint.
   */
  cropSize: number;
  /** How many starter frames to seed before the first locator training. */
  seedFrames: number;
  /** Prompt to train the locator once this many centroids have been seeded. */
  trainAfter: number;
  training: LocatorTrainingConfig;
}

/** One ordered group of keypoints labeled together in a single pass. */
export interface LabelPass {
  name: string;
  /** Skeleton node names, in the order they are clicked. */
  nodes: string[];
  /**
   * When true, THIS pass defines the animal's axis line: its first and last
   * nodes are the line's endpoints, and that line is drawn on the crop as a
   * reference guide while labeling the OTHER passes (helpful for placing
   * left/right pairs symmetrically). At most one pass is the axis — a single
   * reference line — which {@link normalizeActiveLearningConfig} enforces.
   * (Rendering the guide on the labeling canvas is a follow-up; the config +
   * builder capture the intent today.)
   */
  axis: boolean;
}

/** Phase 2: multi-pass keypoint labeling. */
export interface LabelKeypointsConfig {
  order: PassOrder;
  passes: LabelPass[];
}

/** Phase 3: mine hard examples. */
export interface MineConfig {
  enabled: boolean;
  strategies: MineStrategy[];
  /** Predicted points at or below this score are flagged for review. */
  scoreThreshold: number;
  /** Whether to build a per-keypoint (not just per-frame) review queue. */
  keypointReview: boolean;
}

/**
 * Label-consistency benchmark. Re-shows a fraction of crops a second time to
 * measure intra-rater agreement. Replicate labels are STATS-ONLY — the first
 * labeling is always canonical for training.
 */
export interface ConsistencyConfig {
  enabled: boolean;
  /** Fraction of crops to re-show, in [0, 1]. */
  fraction: number;
  /** Shuffle so repeats aren't adjacent (the labeler shouldn't notice). */
  blind: boolean;
}

export interface ActiveLearningConfig {
  version: number;
  loop: LoopConfig;
  localize: LocalizeConfig;
  labelKeypoints: LabelKeypointsConfig;
  mine: MineConfig;
  consistency: ConsistencyConfig;
}

/**
 * Built-in default config. This is the SOURCE OF TRUTH for defaults — the
 * user-facing YAML template is produced from it via
 * {@link serializeActiveLearningConfig}, so the two never drift. The pass
 * layout below is a rodent example; every field is meant to be overridden.
 */
export const DEFAULT_ACTIVE_LEARNING_CONFIG: ActiveLearningConfig = {
  version: ACTIVE_LEARNING_CONFIG_VERSION,
  loop: {
    maxRounds: 5,
    stopWhen: { metricPlateau: true },
  },
  localize: {
    enabled: true,
    centroidNode: "body_center",
    separateCentroid: false,
    cropSize: 256,
    seedFrames: 20,
    trainAfter: 100,
    training: {
      backbone: "unet",
      inputScale: 0.5,
      maxEpochs: 100,
      batchSize: 4,
      augmentation: "minimal",
      earlyStop: true,
    },
  },
  labelKeypoints: {
    order: "pass-major",
    passes: [
      // "Body Axis" is the axis pass: its first & last nodes (tti → nose) define
      // the reference line shown while labeling the later passes.
      { name: "Body Axis", nodes: ["tti", "trunk", "neck", "head", "nose"], axis: true },
      {
        name: "Anterior",
        nodes: ["left_ear", "right_ear", "left_shoulder", "right_shoulder"],
        axis: false,
      },
      { name: "Posterior", nodes: ["left_haunch", "right_haunch"], axis: false },
      { name: "Tail", nodes: ["tail_base", "tail_mid", "tail_tip"], axis: false },
    ],
  },
  mine: {
    enabled: true,
    strategies: ["prediction_score", "velocity"],
    scoreThreshold: 0.3,
    keypointReview: true,
  },
  consistency: {
    enabled: true,
    fraction: 0.1,
    blind: true,
  },
};

// ---------------------------------------------------------------------------
// Coercion helpers — keep parsing lenient so partial YAML always fills in.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function strArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : fallback;
}

function normalizePass(raw: unknown, index: number): LabelPass {
  const r = asRecord(raw);
  return {
    name: str(r.name, `Pass ${index + 1}`),
    nodes: strArray(r.nodes, []),
    // Back-compat: the retired per-pass `guide: "axis"` maps onto the axis flag.
    axis: r.axis === true || r.guide === "axis",
  };
}

/**
 * Merge a raw (possibly partial) parsed object with the defaults into a
 * complete {@link ActiveLearningConfig}. Arrays (`passes`, `strategies`) are
 * replaced wholesale when present rather than merged element-wise.
 */
export function normalizeActiveLearningConfig(raw: unknown): ActiveLearningConfig {
  const d = DEFAULT_ACTIVE_LEARNING_CONFIG;
  const root = asRecord(raw);

  const loop = asRecord(root.loop);
  const localize = asRecord(root.localize);
  const localizeTraining = asRecord(localize.training);
  const labelKeypoints = asRecord(root.labelKeypoints);
  const mine = asRecord(root.mine);
  const consistency = asRecord(root.consistency);

  const order = str(labelKeypoints.order, d.labelKeypoints.order);
  // Fresh objects either way (clone the defaults) so the single-axis pass below
  // never mutates the shared DEFAULT constant.
  const passes = Array.isArray(labelKeypoints.passes)
    ? labelKeypoints.passes.map(normalizePass)
    : d.labelKeypoints.passes.map((p) => ({ ...p }));
  // At most one pass is the axis (a single reference line): keep the first
  // axis-flagged pass, clear the rest.
  let axisClaimed = false;
  for (const p of passes) {
    if (p.axis && !axisClaimed) axisClaimed = true;
    else if (p.axis) p.axis = false;
  }

  const strategies = (
    Array.isArray(mine.strategies)
      ? strArray(mine.strategies, d.mine.strategies)
      : d.mine.strategies
  ).filter(
    (s): s is MineStrategy =>
      s === "prediction_score" || s === "velocity" || s === "max_displacement",
  );

  return {
    version: num(root.version, d.version),
    loop: {
      maxRounds: num(loop.maxRounds, d.loop.maxRounds),
      stopWhen: {
        metricPlateau: bool(asRecord(loop.stopWhen).metricPlateau, d.loop.stopWhen.metricPlateau),
      },
    },
    localize: {
      enabled: bool(localize.enabled, d.localize.enabled),
      // An explicit `null` selects the ARBITRARY-centroid mode; anything else
      // coerces to a node name (falling back to the default when absent).
      centroidNode:
        localize.centroidNode === null
          ? null
          : str(localize.centroidNode, d.localize.centroidNode ?? ""),
      separateCentroid: bool(localize.separateCentroid, d.localize.separateCentroid),
      cropSize: num(localize.cropSize, d.localize.cropSize),
      seedFrames: num(localize.seedFrames, d.localize.seedFrames),
      trainAfter: num(localize.trainAfter, d.localize.trainAfter),
      training: {
        backbone: oneOf(
          localizeTraining.backbone,
          ["unet", "convnext", "swint"] as const,
          d.localize.training.backbone,
        ),
        inputScale: num(localizeTraining.inputScale, d.localize.training.inputScale),
        maxEpochs: num(localizeTraining.maxEpochs, d.localize.training.maxEpochs),
        batchSize: num(localizeTraining.batchSize, d.localize.training.batchSize),
        augmentation: oneOf(
          localizeTraining.augmentation,
          ["minimal", "rotation", "rotation-intensity"] as const,
          d.localize.training.augmentation,
        ),
        earlyStop: bool(localizeTraining.earlyStop, d.localize.training.earlyStop),
      },
    },
    labelKeypoints: {
      order: order === "crop-major" ? "crop-major" : "pass-major",
      passes,
    },
    mine: {
      enabled: bool(mine.enabled, d.mine.enabled),
      strategies: strategies.length > 0 ? strategies : d.mine.strategies,
      scoreThreshold: num(mine.scoreThreshold, d.mine.scoreThreshold),
      keypointReview: bool(mine.keypointReview, d.mine.keypointReview),
    },
    consistency: {
      enabled: bool(consistency.enabled, d.consistency.enabled),
      fraction: num(consistency.fraction, d.consistency.fraction),
      blind: bool(consistency.blind, d.consistency.blind),
    },
  };
}

/**
 * Parse a YAML string into a complete config. Lenient: unknown/missing fields
 * fall back to defaults. Throws only if the YAML itself is malformed (via
 * js-yaml). Semantic validation is separate — see
 * {@link validateActiveLearningConfig}.
 */
export function parseActiveLearningConfig(text: string): ActiveLearningConfig {
  return normalizeActiveLearningConfig(yaml.load(text));
}

/** Serialize a config to YAML (used for the downloadable template / save). */
export function serializeActiveLearningConfig(config: ActiveLearningConfig): string {
  return yaml.dump(config, { noRefs: true, lineWidth: 100 });
}

/** The phases of the active-learning loop, in canonical order. */
export type ActiveLearningPhase = "localize" | "labelKeypoints" | "mine";

/**
 * The first phase that is actually enabled/usable for a config, or `null` if
 * none are. Localize runs only when enabled; label-keypoints runs whenever it
 * has passes; mine runs only when enabled.
 */
export function firstEnabledPhase(config: ActiveLearningConfig): ActiveLearningPhase | null {
  if (config.localize.enabled) return "localize";
  if (config.labelKeypoints.passes.length > 0) return "labelKeypoints";
  if (config.mine.enabled) return "mine";
  return null;
}

/**
 * Guess a reasonable centroid/anchor node from a skeleton's node names: prefer
 * a central-body name, else fall back to the first node. Only a starting guess
 * — the user edits `localize.centroidNode` to taste.
 */
export function pickCentroidNode(nodeNames: string[]): string {
  const central = /trunk|thorax|centroid|center|body|spine|abdomen/i;
  return nodeNames.find((n) => central.test(n)) ?? nodeNames[0] ?? "";
}

/**
 * Build a VALID starter config from a skeleton's node names: every node goes
 * into a single "Keypoints" pass and the centroid is guessed via
 * {@link pickCentroidNode}. This lets "define the workflow" work for any
 * skeleton without hand-writing node names — the user then splits the one pass
 * into ordered passes and adjusts the centroid.
 */
export function configFromSkeleton(
  nodeNames: string[],
  centroidNode?: string,
): ActiveLearningConfig {
  const d = DEFAULT_ACTIVE_LEARNING_CONFIG;
  return {
    ...d,
    localize: {
      ...d.localize,
      centroidNode: centroidNode ?? pickCentroidNode(nodeNames),
    },
    labelKeypoints: {
      order: "pass-major",
      passes:
        nodeNames.length > 0
          ? [{ name: "Keypoints", nodes: [...nodeNames], axis: false }]
          : d.labelKeypoints.passes,
    },
  };
}

/** Flat, de-duplicated list of every node named across all labeling passes. */
export function allPassNodes(config: ActiveLearningConfig): string[] {
  const seen = new Set<string>();
  for (const pass of config.labelKeypoints.passes) {
    for (const node of pass.nodes) seen.add(node);
  }
  return [...seen];
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a config's semantics. Pass `skeletonNodeNames` (from the project's
 * active skeleton) to check that every pass node and the centroid node actually
 * exist — the main reason validation is deferred to load time rather than parse
 * time. Errors block use; warnings are advisory.
 */
export function validateActiveLearningConfig(
  config: ActiveLearningConfig,
  skeletonNodeNames?: string[],
): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.version > ACTIVE_LEARNING_CONFIG_VERSION) {
    errors.push(
      `Config version ${config.version} is newer than supported version ${ACTIVE_LEARNING_CONFIG_VERSION}.`,
    );
  }

  if (config.loop.maxRounds < 1) {
    errors.push(`loop.maxRounds must be at least 1 (got ${config.loop.maxRounds}).`);
  }

  if (config.localize.enabled && config.localize.cropSize <= 0) {
    errors.push(`localize.cropSize must be positive (got ${config.localize.cropSize}).`);
  }

  if (config.localize.trainAfter < 1) {
    errors.push(`localize.trainAfter must be at least 1 (got ${config.localize.trainAfter}).`);
  }

  if (config.localize.enabled) {
    const t = config.localize.training;
    if (t.inputScale <= 0 || t.inputScale > 1) {
      errors.push(`localize.training.inputScale must be in (0, 1] (got ${t.inputScale}).`);
    }
    if (t.maxEpochs < 1) {
      errors.push(`localize.training.maxEpochs must be at least 1 (got ${t.maxEpochs}).`);
    }
    if (t.batchSize < 1) {
      errors.push(`localize.training.batchSize must be at least 1 (got ${t.batchSize}).`);
    }
  }

  if (config.consistency.fraction < 0 || config.consistency.fraction > 1) {
    errors.push(
      `consistency.fraction must be in [0, 1] (got ${config.consistency.fraction}).`,
    );
  }

  const passes = config.labelKeypoints.passes;
  if (passes.length === 0) {
    errors.push("labelKeypoints.passes must contain at least one pass.");
  }

  // Per-pass node checks + duplicate-across-passes detection.
  const nodeToPass = new Map<string, string>();
  for (const pass of passes) {
    if (pass.nodes.length === 0) {
      errors.push(`Pass "${pass.name}" has no nodes.`);
    }
    // The axis pass needs two endpoints (first + last node) to form a line.
    if (pass.axis && pass.nodes.length < 2) {
      warnings.push(
        `Axis pass "${pass.name}" has fewer than 2 nodes, so no axis line can be drawn.`,
      );
    }
    for (const node of pass.nodes) {
      const prev = nodeToPass.get(node);
      if (prev !== undefined && prev !== pass.name) {
        warnings.push(
          `Node "${node}" appears in more than one pass ("${prev}" and "${pass.name}").`,
        );
      }
      nodeToPass.set(node, pass.name);
    }
  }

  if (skeletonNodeNames) {
    const known = new Set(skeletonNodeNames);
    for (const node of allPassNodes(config)) {
      if (!known.has(node)) {
        errors.push(`Pass node "${node}" is not in the skeleton.`);
      }
    }
    // Only validate the centroid against the pose skeleton when it's actually a
    // pose node: a `null` centroid is unmaterialized, and a separate centroid
    // annotation lives outside the pose skeleton by design.
    if (
      config.localize.enabled &&
      config.localize.centroidNode !== null &&
      !config.localize.separateCentroid &&
      !known.has(config.localize.centroidNode)
    ) {
      errors.push(`localize.centroidNode "${config.localize.centroidNode}" is not in the skeleton.`);
    }
    const covered = new Set(allPassNodes(config));
    // The centroid node is placed during Phase-1 seeding, not a keypoint pass,
    // so it is legitimately absent from the passes — don't warn about it. (A
    // separate-skeleton centroid isn't a pose node at all, so skip it too.)
    if (
      config.localize.enabled &&
      config.localize.centroidNode !== null &&
      !config.localize.separateCentroid
    ) {
      covered.add(config.localize.centroidNode);
    }
    for (const node of skeletonNodeNames) {
      if (!covered.has(node)) {
        warnings.push(`Skeleton node "${node}" is not labeled by any pass.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
