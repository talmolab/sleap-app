/**
 * Predefined skeleton templates for common organisms.
 *
 * Each template defines nodes and edges that can be loaded into the skeleton
 * editor to quickly set up annotation for standard body plans.
 */

export interface SkeletonTemplate {
  name: string;
  description: string;
  nodes: string[];
  edges: [number, number][];
  /** Left/right node pairs, as node indices. */
  symmetries?: [number, number][];
  /**
   * A labeled example of this skeleton, shown before loading it: a file in
   * `public/skeleton-templates/`. The reference-dataset templates carry the
   * preview images legacy SLEAP shipped with them.
   */
  previewImage?: string;
}

/** Drosophila melanogaster (fruit fly) — 32 nodes, top-down view. */
const fly: SkeletonTemplate = {
  name: "Fly (32 nodes)",
  description: "Drosophila melanogaster, top-down view",
  nodes: [
    "head",
    "eyeL",
    "eyeR",
    "neck",
    "thorax",
    "abdomen",
    "wingL",
    "wingR",
    "forelegL_coxa",
    "forelegL_femur",
    "forelegL_tibia",
    "forelegL_tarsus",
    "forelegR_coxa",
    "forelegR_femur",
    "forelegR_tibia",
    "forelegR_tarsus",
    "midlegL_coxa",
    "midlegL_femur",
    "midlegL_tibia",
    "midlegL_tarsus",
    "midlegR_coxa",
    "midlegR_femur",
    "midlegR_tibia",
    "midlegR_tarsus",
    "hindlegL_coxa",
    "hindlegL_femur",
    "hindlegL_tibia",
    "hindlegL_tarsus",
    "hindlegR_coxa",
    "hindlegR_femur",
    "hindlegR_tibia",
    "hindlegR_tarsus",
  ],
  edges: [
    [0, 1], // head -> eyeL
    [0, 2], // head -> eyeR
    [0, 3], // head -> neck
    [3, 4], // neck -> thorax
    [4, 5], // thorax -> abdomen
    [4, 6], // thorax -> wingL
    [4, 7], // thorax -> wingR
    // Foreleg L
    [3, 8],
    [8, 9],
    [9, 10],
    [10, 11],
    // Foreleg R
    [3, 12],
    [12, 13],
    [13, 14],
    [14, 15],
    // Midleg L
    [4, 16],
    [16, 17],
    [17, 18],
    [18, 19],
    // Midleg R
    [4, 20],
    [20, 21],
    [21, 22],
    [22, 23],
    // Hindleg L
    [4, 24],
    [24, 25],
    [25, 26],
    [26, 27],
    // Hindleg R
    [4, 28],
    [28, 29],
    [29, 30],
    [30, 31],
  ],
};

/** Mouse top-down view — 12 nodes. */
const mouseTopdown: SkeletonTemplate = {
  name: "Mouse top-down (12 nodes)",
  description: "Mouse, top-down view",
  nodes: [
    "nose",
    "earL",
    "earR",
    "spine1",
    "spine2",
    "spine3",
    "spine4",
    "tailBase",
    "tailTip",
    "forepawL",
    "forepawR",
    "hindpawL",
  ],
  edges: [
    [0, 1], // nose -> earL
    [0, 2], // nose -> earR
    [0, 3], // nose -> spine1
    [3, 4], // spine1 -> spine2
    [4, 5], // spine2 -> spine3
    [5, 6], // spine3 -> spine4
    [6, 7], // spine4 -> tailBase
    [7, 8], // tailBase -> tailTip
    [3, 9], // spine1 -> forepawL
    [3, 10], // spine1 -> forepawR
    [6, 11], // spine4 -> hindpawL
  ],
};

/** Human COCO-style keypoints — 17 nodes. */
const human: SkeletonTemplate = {
  name: "Human (17 nodes)",
  description: "COCO-style human keypoints",
  nodes: [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
  ],
  edges: [
    [0, 1], // nose -> left_eye
    [0, 2], // nose -> right_eye
    [1, 3], // left_eye -> left_ear
    [2, 4], // right_eye -> right_ear
    [5, 6], // left_shoulder -> right_shoulder
    [5, 7], // left_shoulder -> left_elbow
    [7, 9], // left_elbow -> left_wrist
    [6, 8], // right_shoulder -> right_elbow
    [8, 10], // right_elbow -> right_wrist
    [5, 11], // left_shoulder -> left_hip
    [6, 12], // right_shoulder -> right_hip
    [11, 12], // left_hip -> right_hip
    [11, 13], // left_hip -> left_knee
    [13, 15], // left_knee -> left_ankle
    [12, 14], // right_hip -> right_knee
    [14, 16], // right_knee -> right_ankle
  ],
};

/** C. elegans — 2 nodes. */
const celegans: SkeletonTemplate = {
  name: "C. elegans (2 nodes)",
  description: "Caenorhabditis elegans, head and tail",
  nodes: ["head", "tail"],
  edges: [[0, 1]],
};

/** Empty/custom skeleton — 0 nodes. */
const custom: SkeletonTemplate = {
  name: "Custom (empty)",
  description: "Blank skeleton for custom body plan",
  nodes: [],
  edges: [],
};

// The skeleton templates legacy SLEAP shipped (sleap/skeletons/*.json), with
// their nodes, edges, symmetries and preview images copied exactly.

/** SLEAP's `bees` reference-dataset template (21 nodes). */
const beesRef: SkeletonTemplate = {
  name: "Bees (21 nodes)",
  description: "Bees, from the SLEAP bees reference dataset",
  nodes: ["thorax1", "head1", "abdomen1", "antennaL1", "antennaL2", "antennaR1", "antennaR2", "forelegL1", "forelegL2", "forelegR1", "forelegR2", "midlegL1", "midlegL2", "midlegR1", "midlegR2", "hindlegL1", "hindlegL2", "hindlegR1", "hindlegR2", "wingL1", "wingR1"],
  edges: [[0, 1], [0, 2], [0, 7], [0, 9], [0, 11], [0, 13], [0, 15], [0, 17], [0, 19], [0, 20], [1, 3], [1, 5], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18]],
  previewImage: "bees.png",
};

/** SLEAP's `flies13` reference-dataset template (13 nodes). */
const flies13Ref: SkeletonTemplate = {
  name: "Flies 13 (13 nodes)",
  description: "Fruit flies, 13 nodes, from the SLEAP flies13 reference dataset",
  nodes: ["head1", "thorax1", "abdomen1", "wingL1", "wingR1", "forelegL1", "forelegR1", "midlegL1", "midlegR1", "hindlegL1", "hindlegR1", "eyeL1", "eyeR1"],
  edges: [[0, 11], [0, 12], [1, 0], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [1, 9], [1, 10]],
  symmetries: [[4, 3], [6, 5], [8, 7], [9, 10], [11, 12]],
  previewImage: "flies13.png",
};

/** SLEAP's `fly32` reference-dataset template (32 nodes). */
const fly32Ref: SkeletonTemplate = {
  name: "Fly 32 (reference) (32 nodes)",
  description: "Fruit fly, 32 nodes, from the SLEAP fly32 reference dataset",
  nodes: ["head1", "eyeL1", "eyeR1", "neck1", "thorax1", "abdomen1", "forelegR1", "forelegR2", "forelegR3", "forelegR4", "midlegR1", "midlegR2", "midlegR3", "midlegR4", "hindlegR1", "hindlegR2", "hindlegR3", "hindlegR4", "forelegL1", "forelegL2", "forelegL3", "forelegL4", "midlegL1", "midlegL2", "midlegL3", "midlegL4", "hindlegL1", "hindlegL2", "hindlegL3", "hindlegL4", "wingL1", "wingR1"],
  edges: [[0, 1], [0, 2], [0, 3], [3, 4], [3, 30], [3, 31], [4, 5], [6, 7], [7, 8], [8, 9], [10, 11], [11, 12], [12, 13], [14, 15], [15, 16], [16, 17], [18, 19], [19, 20], [20, 21], [22, 23], [23, 24], [24, 25], [26, 27], [27, 28], [28, 29]],
  previewImage: "fly32.png",
};

/** SLEAP's `gerbils` reference-dataset template (14 nodes). */
const gerbilsRef: SkeletonTemplate = {
  name: "Gerbils (14 nodes)",
  description: "Gerbils, from the SLEAP gerbils reference dataset",
  nodes: ["nose1", "eyeL1", "eyeR1", "earL1", "earR1", "spinestart1", "spine1", "spine2", "spineend1", "tailstart1", "tail1", "tail2", "tail3", "tailend1"],
  edges: [[5, 1], [5, 3], [5, 0], [5, 2], [5, 4], [6, 5], [7, 6], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]],
  symmetries: [[2, 1], [4, 3]],
  previewImage: "gerbils.png",
};

/** SLEAP's `mice_hc` reference-dataset template (5 nodes). */
const miceHcRef: SkeletonTemplate = {
  name: "Mice, home cage (5 nodes)",
  description: "Mice in a home cage, from the SLEAP mice_hc reference dataset",
  nodes: ["nose1", "earL1", "earR1", "tailstart1", "tailend1"],
  edges: [[0, 1], [0, 2], [0, 3], [3, 4]],
  previewImage: "mice_hc.png",
};

/** SLEAP's `mice_of` reference-dataset template (11 nodes). */
const miceOfRef: SkeletonTemplate = {
  name: "Mice, open field (11 nodes)",
  description: "Mice in an open field, from the SLEAP mice_of reference dataset",
  nodes: ["nose1", "neck1", "earL1", "earR1", "forelegL1", "forelegR1", "tailstart1", "hindlegL1", "hindlegR1", "tail1", "tailend1"],
  edges: [[1, 4], [1, 5], [1, 0], [1, 3], [1, 2], [6, 8], [6, 7], [6, 9], [6, 1], [9, 10]],
  previewImage: "mice_of.png",
};

/** All available skeleton templates keyed by ID. */
export const SKELETON_TEMPLATES: Record<string, SkeletonTemplate> = {
  fly,
  mouse_topdown: mouseTopdown,
  human,
  celegans,
  bees: beesRef,
  flies13: flies13Ref,
  fly32: fly32Ref,
  gerbils: gerbilsRef,
  mice_hc: miceHcRef,
  mice_of: miceOfRef,
  custom,
};

/** Ordered list of template IDs for UI display. */
export const TEMPLATE_ORDER = [
  "fly",
  "mouse_topdown",
  "human",
  "celegans",
  "bees",
  "flies13",
  "fly32",
  "gerbils",
  "mice_hc",
  "mice_of",
  "custom",
] as const;
