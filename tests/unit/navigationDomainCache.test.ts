/**
 * Tests for the navigation-domain cache (Cluster B perf).
 *
 * The "navigation domain" (sorted labeled/user/track-spawn frame indices for a
 * video) is a pure function of (labels content, video). Label content changes
 * are signalled by the app's `editSeq` counter (bumped by `markChanged`). The
 * cache memoizes each domain keyed on (labels ref, video ref, editSeq) so
 * arrow-key stepping, playback ticks, and seekbar repaints reuse one scan
 * instead of re-walking every frame each call.
 *
 * The load-bearing assertions here are the REFERENCE-IDENTITY ones: a cache hit
 * returns the very same array object (no rescan); an invalidation returns a
 * fresh one. That is what proves the per-step full scan is gone.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import {
  cachedNavigableDomain,
  cachedAllLabeledFrameIndices,
  cachedUserFrameIndices,
  cachedTrackSpawnFrames,
  resetNavigationDomainCache,
} from "@/lib/navigationDomainCache";
import {
  navigableDomain,
  allLabeledFrameIndices,
  userLabeledFrameIndices,
  trackSpawnFrameIndices,
} from "@/lib/navigableFrames";
import {
  Labels,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

function makeVideo(name = "cache.mp4") {
  return new Video({
    filename: name,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function userInst(skeleton: Skeleton) {
  return Instance.empty({ skeleton });
}
function predInst(skeleton: Skeleton, track?: Track) {
  const inst = PredictedInstance.fromArray(
    [
      [0, 0],
      [1, 1],
    ],
    skeleton,
    0.9
  );
  if (track) inst.track = track;
  return inst;
}
function addFrame(
  labels: Labels,
  video: Video,
  frameIdx: number,
  instances: (Instance | PredictedInstance)[]
) {
  labels.labeledFrames.push(new LabeledFrame({ video, frameIdx, instances }));
}

/**
 * A project with three distinct domains:
 *   - user frames at 10 / 30
 *   - a predicted-only frame at 20 (labeled but not user-labeled)
 *   - an empty frame at 50 (a LabeledFrame with no instances)
 * so the three cached domains come out different:
 *   allLabeled = [10,20,30,50]  (includes empty)
 *   navigable "labeled" = [10,20,30]  (excludes empty, keeps predicted)
 *   user = [10,30]
 */
function makeProject() {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = makeVideo();
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  addFrame(labels, video, 10, [userInst(skeleton)]);
  addFrame(labels, video, 20, [predInst(skeleton)]);
  addFrame(labels, video, 30, [userInst(skeleton)]);
  addFrame(labels, video, 50, []); // empty LabeledFrame
  return { labels, video, skeleton };
}

beforeEach(() => {
  resetNavigationDomainCache();
});

describe("cachedNavigableDomain — equivalence with the uncached builder", () => {
  it("matches navigableDomain for every mode", () => {
    const { labels, video } = makeProject();
    expect(cachedNavigableDomain(labels, video, "all", 0)).toEqual(
      navigableDomain(labels, video, "all")
    );
    expect(cachedNavigableDomain(labels, video, "labeled", 0)).toEqual(
      navigableDomain(labels, video, "labeled")
    );
    // "imaged" on a normal (non-embedded) video is null in both.
    expect(cachedNavigableDomain(labels, video, "imaged", 0)).toEqual(
      navigableDomain(labels, video, "imaged")
    );
  });
});

describe("cachedNavigableDomain — memoization", () => {
  it("returns the SAME array reference on a cache hit (no rescan)", () => {
    const { labels, video } = makeProject();
    const first = cachedNavigableDomain(labels, video, "labeled", 5);
    const second = cachedNavigableDomain(labels, video, "labeled", 5);
    expect(second).toBe(first); // identical object => not recomputed
  });

  it("recomputes (fresh reference, new content) when editSeq advances", () => {
    const { labels, video, skeleton } = makeProject();
    const before = cachedNavigableDomain(labels, video, "labeled", 5);
    expect(before).toEqual([10, 20, 30]);

    // Simulate an edit: add a labeled frame and bump editSeq.
    addFrame(labels, video, 40, [userInst(skeleton)]);
    const after = cachedNavigableDomain(labels, video, "labeled", 6);
    expect(after).not.toBe(before);
    expect(after).toEqual([10, 20, 30, 40]);
  });

  it("serves the cached (stale) value while editSeq is unchanged", () => {
    // Documents the invalidation contract: the cache trusts editSeq as the
    // sole content-version signal (markChanged bumps it on every edit).
    const { labels, video, skeleton } = makeProject();
    const before = cachedNavigableDomain(labels, video, "labeled", 5);
    addFrame(labels, video, 40, [userInst(skeleton)]); // edit WITHOUT bumping editSeq
    const after = cachedNavigableDomain(labels, video, "labeled", 5);
    expect(after).toBe(before);
    expect(after).toEqual([10, 20, 30]); // 40 not yet visible — as designed
  });

  it("recomputes when the video changes", () => {
    const { labels, skeleton } = makeProject();
    const videoA = labels.videos[0] as Video;
    const videoB = makeVideo("b.mp4");
    labels.videos.push(videoB);
    addFrame(labels, videoB, 7, [userInst(skeleton)]);

    const a = cachedNavigableDomain(labels, videoA, "labeled", 5);
    const b = cachedNavigableDomain(labels, videoB, "labeled", 5);
    expect(a).toEqual([10, 20, 30]);
    expect(b).toEqual([7]);
    expect(b).not.toBe(a);
  });

  it("recomputes when the labels reference changes (new project)", () => {
    const p1 = makeProject();
    const first = cachedNavigableDomain(p1.labels, p1.video, "labeled", 0);
    const p2 = makeProject();
    const second = cachedNavigableDomain(p2.labels, p2.video, "labeled", 0);
    expect(second).not.toBe(first);
  });
});

describe("cached per-kind indices", () => {
  it("cachedAllLabeledFrameIndices matches the builder and memoizes", () => {
    const { labels, video } = makeProject();
    const a = cachedAllLabeledFrameIndices(labels, video, 3);
    expect(a).toEqual(allLabeledFrameIndices(labels, video)); // [10,20,30,50] incl. empty
    expect(cachedAllLabeledFrameIndices(labels, video, 3)).toBe(a);
  });

  it("cachedUserFrameIndices matches the builder and memoizes", () => {
    const { labels, video } = makeProject();
    const u = cachedUserFrameIndices(labels, video, 3);
    expect(u).toEqual(userLabeledFrameIndices(labels, video)); // [10,30]
    expect(cachedUserFrameIndices(labels, video, 3)).toBe(u);
  });

  it("cachedTrackSpawnFrames matches the builder and memoizes", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo();
    const trackA = new Track("A");
    const trackB = new Track("B");
    const labels = new Labels({ videos: [video], skeletons: [skeleton] });
    labels.tracks = [trackA, trackB];
    addFrame(labels, video, 15, [predInst(skeleton, trackA)]);
    addFrame(labels, video, 5, [predInst(skeleton, trackA)]);
    addFrame(labels, video, 10, [predInst(skeleton, trackB)]);

    const s = cachedTrackSpawnFrames(labels, video, 3);
    expect(s).toEqual(trackSpawnFrameIndices(labels, video)); // [5,10]
    expect(cachedTrackSpawnFrames(labels, video, 3)).toBe(s);
  });

  it("keeps distinct kinds in the same slot without clobbering each other", () => {
    const { labels, video } = makeProject();
    const all = cachedAllLabeledFrameIndices(labels, video, 9);
    const user = cachedUserFrameIndices(labels, video, 9);
    const labeled = cachedNavigableDomain(labels, video, "labeled", 9);
    expect(all).toEqual([10, 20, 30, 50]); // includes empty frame
    expect(user).toEqual([10, 30]); // user only
    expect(labeled).toEqual([10, 20, 30]); // excludes empty, keeps predicted
    // All three still served from cache (same refs) after the interleaving.
    expect(cachedAllLabeledFrameIndices(labels, video, 9)).toBe(all);
    expect(cachedUserFrameIndices(labels, video, 9)).toBe(user);
    expect(cachedNavigableDomain(labels, video, "labeled", 9)).toBe(labeled);
  });
});

describe("resetNavigationDomainCache", () => {
  it("forces the next call to recompute", () => {
    const { labels, video } = makeProject();
    const first = cachedNavigableDomain(labels, video, "labeled", 5);
    resetNavigationDomainCache();
    const second = cachedNavigableDomain(labels, video, "labeled", 5);
    expect(second).not.toBe(first);
    expect(second).toEqual(first); // same content, fresh object
  });
});
