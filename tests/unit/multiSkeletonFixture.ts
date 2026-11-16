/**
 * Test helper: a two-skeleton project built in code (no hand-edited fixture).
 *
 * One video, a 3-node "mouse" skeleton (head → body → tail) and a 1-node
 * "pellet" centroid skeleton. Frame 0 holds two mice and one pellet; frame 10
 * holds one mouse and one pellet.
 */

import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

export function makeMouseSkeleton(): Skeleton {
  const sk = new Skeleton({ nodes: ["head", "body", "tail"], name: "mouse" });
  sk.addEdge(sk.nodes[0], sk.nodes[1]);
  sk.addEdge(sk.nodes[1], sk.nodes[2]);
  return sk;
}

export function makePelletSkeleton(): Skeleton {
  return new Skeleton({ nodes: ["centroid"], name: "pellet" });
}

/** An instance with every point placed at `base + 10 * nodeIdx`. */
export function placedInstance(skeleton: Skeleton, base: [number, number]): Instance {
  const inst = Instance.empty({ skeleton });
  inst.points = inst.points.map((p, i) => ({
    ...p,
    xy: [base[0] + 10 * i, base[1] + 10 * i] as [number, number],
    visible: true,
    complete: true,
  }));
  return inst;
}

export function makeTwoSkeletonProject() {
  const mouse = makeMouseSkeleton();
  const pellet = makePelletSkeleton();
  const video = new Video({
    filename: "arena.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
  const labels = new Labels({ videos: [video], skeletons: [mouse, pellet] });

  const f0 = new LabeledFrame({ video, frameIdx: 0 });
  f0.instances.push(
    placedInstance(mouse, [100, 100]),
    placedInstance(mouse, [300, 100]),
    placedInstance(pellet, [200, 300]),
  );
  const f10 = new LabeledFrame({ video, frameIdx: 10 });
  f10.instances.push(placedInstance(mouse, [110, 110]), placedInstance(pellet, [210, 310]));
  labels.labeledFrames.push(f0, f10);

  return { labels, video, mouse, pellet, f0, f10 };
}
