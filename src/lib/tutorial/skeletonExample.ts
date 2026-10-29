/**
 * The example skeleton the "Create a skeleton" card can show: one mouse from
 * the sample video with head, torso and tailbase placed and the two edges
 * drawn from torso, so a first-time user can see what they're about to make.
 *
 * The image (public/tutorial/mouse-skeleton-example.jpg) is mice.mp4 frame
 * 1410 (the frame the tutorial labels), cropped to x 360–560, y 262–382 and
 * saved at 2x as a grayscale JPEG. Node positions
 * are a person's labels on that frame (labels.v001.slp from the tutorial
 * data), moved into crop coordinates.
 */

import type { TutorialExample } from "./steps";

// Served from public/ (like background.jpg) rather than imported, so no module
// that reaches the tutorial steps has to load an image: bun's test runner
// tries to parse an imported .jpg as code in some test files.
// `import.meta.env` is read with `?.` so this also loads where Vite's define
// isn't in play (same guard as lib/docsUrl.ts).
const exampleImageUrl = `${import.meta.env?.BASE_URL ?? "/"}tutorial/mouse-skeleton-example.jpg`;

const CROP = { x: 360, y: 262, width: 200, height: 120 };

/** Hand-labeled positions on frame 1410, in full-frame pixels. */
const FRAME_POSITIONS: Record<string, [number, number]> = {
  head: [508.5, 352.8],
  torso: [446.8, 321.4],
  tailbase: [385.2, 305.1],
};

export function skeletonExample(
  nodeNames: readonly string[],
  edges: readonly (readonly [string, string])[],
): TutorialExample {
  return {
    showLabel: "Show an example skeleton",
    hideLabel: "Hide the example skeleton",
    imageUrl: exampleImageUrl,
    alt: "A mouse from the sample video with head, torso and tailbase marked, and edges from torso to head and from torso to tailbase.",
    width: CROP.width,
    height: CROP.height,
    nodes: nodeNames.map((name) => {
      const [x, y] = FRAME_POSITIONS[name];
      return { name, x: x - CROP.x, y: y - CROP.y };
    }),
    edges: edges.map(([source, destination]) => [source, destination]),
    caption: "One mouse from frame 1410. Both edges start at torso; the arrows show the direction you drag.",
  };
}
