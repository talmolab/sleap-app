/**
 * Predefined skeleton templates: the ones legacy SLEAP ships, each with a
 * labeled example image, a human body skeleton, plus a blank skeleton.
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
  /**
   * The reference dataset a template comes from, as legacy SLEAP's dataset docs
   * (`docs/reference/datasets.md`) show it: a larger example figure, with many
   * labeled frames overlaid on the video (a file in `public/skeleton-templates/`),
   * and what was recorded.
   */
  dataset?: {
    exampleImage: string;
    description: string;
  };
}

/** Empty/custom skeleton — 0 nodes. */
const custom: SkeletonTemplate = {
  name: "Custom (empty)",
  description: "Blank skeleton for custom body plan",
  nodes: [],
  edges: [],
};

// The skeleton templates legacy SLEAP shipped (sleap/skeletons/*.json), with
// their nodes, edges, symmetries and preview images copied exactly, plus each
// reference dataset's example figure and description from SLEAP's docs.

/** SLEAP's `bees` reference-dataset template (21 nodes). */
const beesRef: SkeletonTemplate = {
  name: "Bees (21 nodes)",
  description: "Bees, from the SLEAP bees reference dataset",
  nodes: ["thorax1", "head1", "abdomen1", "antennaL1", "antennaL2", "antennaR1", "antennaR2", "forelegL1", "forelegL2", "forelegR1", "forelegR2", "midlegL1", "midlegL2", "midlegR1", "midlegR2", "hindlegL1", "hindlegL2", "hindlegR1", "hindlegR2", "wingL1", "wingR1"],
  edges: [[0, 1], [0, 2], [0, 7], [0, 9], [0, 11], [0, 13], [0, 15], [0, 17], [0, 19], [0, 20], [1, 3], [1, 5], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18]],
  previewImage: "bees.png",
  dataset: {
    exampleImage: "bees.example.jpg",
    description:
      "Pairs of female worker bumblebees (Bombus impatiens) freely interacting in a petri dish with hexagonal beeswax flooring for up to 30 minutes.",
  },
};

/** SLEAP's `flies13` reference-dataset template (13 nodes). */
const flies13Ref: SkeletonTemplate = {
  name: "Flies 13 (13 nodes)",
  description: "Fruit flies, 13 nodes, from the SLEAP flies13 reference dataset",
  nodes: ["head1", "thorax1", "abdomen1", "wingL1", "wingR1", "forelegL1", "forelegR1", "midlegL1", "midlegR1", "hindlegL1", "hindlegR1", "eyeL1", "eyeR1"],
  edges: [[0, 11], [0, 12], [1, 0], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [1, 9], [1, 10]],
  symmetries: [[4, 3], [6, 5], [8, 7], [9, 10], [11, 12]],
  previewImage: "flies13.png",
  dataset: {
    exampleImage: "flies13.example.jpg",
    description:
      "Freely interacting pairs of virgin male and female fruit flies (Drosophila melanogaster, NM91 strain) 3 to 5 days post-eclosion. Animals frequently engage in courtship behavior.",
  },
};

/** SLEAP's `fly32` reference-dataset template (32 nodes). */
const fly32Ref: SkeletonTemplate = {
  name: "Fly (32 nodes)",
  description: "Fruit fly, 32 nodes, from the SLEAP fly32 reference dataset",
  nodes: ["head1", "eyeL1", "eyeR1", "neck1", "thorax1", "abdomen1", "forelegR1", "forelegR2", "forelegR3", "forelegR4", "midlegR1", "midlegR2", "midlegR3", "midlegR4", "hindlegR1", "hindlegR2", "hindlegR3", "hindlegR4", "forelegL1", "forelegL2", "forelegL3", "forelegL4", "midlegL1", "midlegL2", "midlegL3", "midlegL4", "hindlegL1", "hindlegL2", "hindlegL3", "hindlegL4", "wingL1", "wingR1"],
  edges: [[0, 1], [0, 2], [0, 3], [3, 4], [3, 30], [3, 31], [4, 5], [6, 7], [7, 8], [8, 9], [10, 11], [11, 12], [12, 13], [14, 15], [15, 16], [16, 17], [18, 19], [19, 20], [20, 21], [22, 23], [23, 24], [24, 25], [26, 27], [27, 28], [28, 29]],
  previewImage: "fly32.png",
  dataset: {
    exampleImage: "fly32.example.jpg",
    description:
      "Animal-centered movies of single fruit fly (Drosophila melanogaster) freely moving in an enclosed circular arena with backlight. Videos were recorded with a camera that followed the animal, so all images are roughly centered.",
  },
};

/** SLEAP's `gerbils` reference-dataset template (14 nodes). */
const gerbilsRef: SkeletonTemplate = {
  name: "Gerbils (14 nodes)",
  description: "Gerbils, from the SLEAP gerbils reference dataset",
  nodes: ["nose1", "eyeL1", "eyeR1", "earL1", "earR1", "spinestart1", "spine1", "spine2", "spineend1", "tailstart1", "tail1", "tail2", "tail3", "tailend1"],
  edges: [[5, 1], [5, 3], [5, 0], [5, 2], [5, 4], [6, 5], [7, 6], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]],
  symmetries: [[2, 1], [4, 3]],
  previewImage: "gerbils.png",
  dataset: {
    exampleImage: "gerbils.example.jpg",
    description:
      "Selected videos from a continuous monitoring setup of a home cage with 2 pup and 2 adult gerbils (Meriones unguiculatus), from P15 to 8 months old. Some animals are partially shaved to distinguish their appearance.",
  },
};

/** SLEAP's `mice_hc` reference-dataset template (5 nodes). */
const miceHcRef: SkeletonTemplate = {
  name: "Mice, home cage (5 nodes)",
  description: "Mice in a home cage, from the SLEAP mice_hc reference dataset",
  nodes: ["nose1", "earL1", "earR1", "tailstart1", "tailend1"],
  edges: [[0, 1], [0, 2], [0, 3], [3, 4]],
  previewImage: "mice_hc.png",
  dataset: {
    exampleImage: "mice_hc.example.jpg",
    description:
      "Pairs of male and female white Swiss Webster mice (Mus musculus) imaged in a home cage environment with lightly-colored bedding, imaged from above. Animals are fairly low contrast with respect to the background.",
  },
};

/** SLEAP's `mice_of` reference-dataset template (11 nodes). */
const miceOfRef: SkeletonTemplate = {
  name: "Mice, open field (11 nodes)",
  description: "Mice in an open field, from the SLEAP mice_of reference dataset",
  nodes: ["nose1", "neck1", "earL1", "earR1", "forelegL1", "forelegR1", "tailstart1", "hindlegL1", "hindlegR1", "tail1", "tailend1"],
  edges: [[1, 4], [1, 5], [1, 0], [1, 3], [1, 2], [6, 8], [6, 7], [6, 9], [6, 1], [9, 10]],
  previewImage: "mice_of.png",
  dataset: {
    exampleImage: "mice_of.example.jpg",
    description:
      "Freely moving C57BL/6J mice (Mus musculus) in 45.7 x 45.7 cm open field arena with a clear acrylic floor, imaged from below to ensure paw visibility.",
  },
};

/**
 * The 17-keypoint COCO human body skeleton: the keypoint set most human pose
 * models share (YOLO-pose, RTMPose/MMPose, ViTPose, OpenPose's COCO mode). Node
 * names are COCO's own, so labels map one-to-one onto COCO data and models.
 * Edges are COCO's 19 limbs, pointed outward from the head and torso.
 *
 * Not from a SLEAP reference dataset, so it has no `dataset` example. Its preview
 * is drawn by us (not a COCO photo: those are Flickr images under each
 * photographer's own license, so they can't be bundled freely).
 */
const humanCoco: SkeletonTemplate = {
  name: "Human, COCO (17 nodes)",
  description: "People, with the 17-keypoint COCO body skeleton most human pose models use",
  nodes: ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"],
  edges: [[0, 1], [0, 2], [1, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]],
  symmetries: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16]],
  previewImage: "human_coco.png",
};

/** All available skeleton templates keyed by ID. */
export const SKELETON_TEMPLATES: Record<string, SkeletonTemplate> = {
  bees: beesRef,
  flies13: flies13Ref,
  fly32: fly32Ref,
  gerbils: gerbilsRef,
  mice_hc: miceHcRef,
  mice_of: miceOfRef,
  human_coco: humanCoco,
  custom,
};

/**
 * Ordered list of template IDs for UI display: legacy SLEAP's order (its
 * template files listed by name), then the human skeleton, then the blank one.
 */
export const TEMPLATE_ORDER = [
  "bees",
  "flies13",
  "fly32",
  "gerbils",
  "mice_hc",
  "mice_of",
  "human_coco",
  "custom",
] as const;
