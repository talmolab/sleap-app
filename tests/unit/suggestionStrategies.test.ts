/**
 * Tests for the pure suggestion-generation strategy module
 * (src/lib/suggestionStrategies.ts).
 *
 * Ports of sleap/gui/suggestions.py (PyQt) generation algorithms:
 * frame_chunk, prediction_score, velocity, max_displacement, and
 * stride/random sampling, plus the global frame-range post-filter and the
 * generateSuggestionFrames dispatcher.
 *
 * All fixtures use REAL Labels/Video/Skeleton/Instance/PredictedInstance/Track
 * from @talmolab/sleap-io.js with backend-less videos (explicit .shape). No
 * frame decode is performed anywhere here.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import {
  generateSuggestionFrames,
  frameChunkFrames,
  predictionScoreFrames,
  velocityFrames,
  maxDisplacementFrames,
  sampleFrames,
  allocateAcrossVideos,
  sampleFramesAcrossVideos,
  applyFrameRangePostFilter,
} from "@/lib/suggestionStrategies";
import type { SuggestionFrame } from "@/types";

/** Backend-less video with an explicit shape (no file to open). */
function makeVideo(frames: number, name = "test.mp4"): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [frames, 480, 640, 3] },
    openBackend: false,
  });
}

/** 2-node skeleton with one edge. */
function makeSkeleton(): Skeleton {
  const skel = new Skeleton({ nodes: ["a", "b"], name: "test" });
  skel.addEdge(skel.nodes[0], skel.nodes[1]);
  return skel;
}

/** A user Instance whose node points are at the given xy coords. */
function userInstance(
  skeleton: Skeleton,
  coords: Array<[number, number]>,
  track: Track | null = null,
): Instance {
  const inst = Instance.empty({ skeleton });
  for (let n = 0; n < coords.length; n++) {
    inst.points[n].xy = coords[n];
    inst.points[n].visible = true;
    inst.points[n].complete = true;
  }
  if (track) inst.track = track;
  return inst;
}

/** A PredictedInstance with a frame-level score and visible points. */
function predictedInstance(
  skeleton: Skeleton,
  score: number,
  coords: Array<[number, number]> = [
    [1, 1],
    [2, 2],
  ],
  track: Track | null = null,
): PredictedInstance {
  const inst = PredictedInstance.fromArray(
    coords.map(([x, y]) => [x, y]),
    skeleton,
    score,
  );
  for (const p of inst.points) {
    p.visible = true;
    p.complete = true;
  }
  if (track) inst.track = track;
  return inst;
}

/** Build Labels with a single video and the supplied labeled frames. */
function makeLabels(
  video: Video,
  skeleton: Skeleton,
  frames: LabeledFrame[],
  tracks: Track[] = [],
): Labels {
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    tracks,
  });
  for (const lf of frames) labels.labeledFrames.push(lf);
  return labels;
}

describe("frameChunkFrames", () => {
  it("returns the 0-based range [from-1, min(to, len))", () => {
    const video = makeVideo(100);
    // 1-based 3..7 inclusive -> 0-based 2,3,4,5,6
    expect(frameChunkFrames(video, 3, 7)).toEqual([2, 3, 4, 5, 6]);
  });

  it("clamps the upper bound to len(video)", () => {
    const video = makeVideo(5);
    // 1-based 3..100 -> 0-based 2,3,4 (len=5)
    expect(frameChunkFrames(video, 3, 100)).toEqual([2, 3, 4]);
  });

  it("returns [] when from > to", () => {
    const video = makeVideo(100);
    expect(frameChunkFrames(video, 10, 5)).toEqual([]);
  });

  it("returns [] when from > len(video)", () => {
    const video = makeVideo(5);
    expect(frameChunkFrames(video, 10, 20)).toEqual([]);
  });
});

describe("predictionScoreFrames", () => {
  it("includes a frame iff lower <= count(score<=limit) <= upper", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);

    // frame 0: two low-score predicted insts (qualified=2) -> in [1,2] -> include
    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(predictedInstance(skel, 1.0));
    lf0.instances.push(predictedInstance(skel, 2.5));

    // frame 1: one low-score predicted inst (qualified=1) -> in [1,2] -> include
    const lf1 = new LabeledFrame({ video, frameIdx: 1 });
    lf1.instances.push(predictedInstance(skel, 0.5));

    // frame 2: three low-score predicted insts (qualified=3) -> > upper -> exclude
    const lf2 = new LabeledFrame({ video, frameIdx: 2 });
    lf2.instances.push(predictedInstance(skel, 1.0));
    lf2.instances.push(predictedInstance(skel, 1.0));
    lf2.instances.push(predictedInstance(skel, 1.0));

    // frame 3: only high-score predicted inst (qualified=0) -> < lower -> exclude
    const lf3 = new LabeledFrame({ video, frameIdx: 3 });
    lf3.instances.push(predictedInstance(skel, 9.0));

    const labels = makeLabels(video, skel, [lf0, lf1, lf2, lf3]);
    // scoreLimit=3, lower=1, upper=2
    expect(predictionScoreFrames(labels, video, 3, 1, 2)).toEqual([0, 1]);
  });

  it("ignores user (non-predicted) instances", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);

    // frame 0: only a user instance -> 0 qualified predicted -> exclude
    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(userInstance(skel, [
      [1, 1],
      [2, 2],
    ]));

    // frame 1: one user + one low-score predicted -> qualified=1 -> include
    const lf1 = new LabeledFrame({ video, frameIdx: 1 });
    lf1.instances.push(userInstance(skel, [
      [3, 3],
      [4, 4],
    ]));
    lf1.instances.push(predictedInstance(skel, 1.0));

    const labels = makeLabels(video, skel, [lf0, lf1]);
    expect(predictionScoreFrames(labels, video, 3, 1, 2)).toEqual([1]);
  });

  it("returns results sorted ascending", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const frames: LabeledFrame[] = [];
    for (const idx of [5, 1, 3]) {
      const lf = new LabeledFrame({ video, frameIdx: idx });
      lf.instances.push(predictedInstance(skel, 1.0));
      frames.push(lf);
    }
    const labels = makeLabels(video, skel, frames);
    expect(predictionScoreFrames(labels, video, 3, 1, 2)).toEqual([1, 3, 5]);
  });

  it("ignores user instances and scoreless predicted instances", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);

    // frame 0: a user instance + a predicted instance whose score is not a
    // number -> neither qualifies -> nQualified=0 < lower -> excluded.
    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(userInstance(skel, [
      [1, 1],
      [2, 2],
    ]));
    const scoreless = predictedInstance(skel, 1.0);
    // Simulate a predicted instance with no numeric score.
    (scoreless as unknown as { score: unknown }).score = undefined;
    lf0.instances.push(scoreless);

    // frame 1: one genuine low-score predicted instance -> qualifies.
    const lf1 = new LabeledFrame({ video, frameIdx: 1 });
    lf1.instances.push(predictedInstance(skel, 1.0));

    const labels = makeLabels(video, skel, [lf0, lf1]);
    expect(predictionScoreFrames(labels, video, 3, 1, 2)).toEqual([1]);
  });
});

describe("velocityFrames", () => {
  /**
   * Build a video whose primary node (index 0) of a single track jumps on
   * specific frames. The displacement series is relative; frames whose value
   * exceeds (min + range*threshold) are returned.
   */
  function makeVelocityLabels(): { labels: Labels; video: Video } {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");

    // primary node x positions per frame: small steps then one large jump.
    // frame 0: x=0; frame 1: x=1 (disp 1); frame 2: x=2 (disp 1);
    // frame 3: x=100 (disp 98 big jump); frame 4: x=101 (disp 1)
    const xs = [0, 1, 2, 100, 101];
    const frames: LabeledFrame[] = [];
    for (let f = 0; f < xs.length; f++) {
      const lf = new LabeledFrame({ video, frameIdx: f });
      lf.instances.push(
        userInstance(
          skel,
          [
            [xs[f], 0],
            [xs[f] + 5, 0],
          ],
          track,
        ),
      );
      frames.push(lf);
    }
    const labels = makeLabels(video, skel, frames, [track]);
    return { labels, video };
  }

  it("returns frames above the relative threshold", () => {
    const { labels, video } = makeVelocityLabels();
    // Low threshold: the big-jump frame (3) is well above min+range*thr.
    const out = velocityFrames(labels, video, 0, 0.1);
    expect(out).toContain(3);
    // ascending order
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });

  it("returns fewer frames at a higher threshold", () => {
    const { labels, video } = makeVelocityLabels();
    const loose = velocityFrames(labels, video, 0, 0.05);
    const strict = velocityFrames(labels, video, 0, 0.9);
    expect(strict.length).toBeLessThanOrEqual(loose.length);
    // the dominant jump frame survives even a strict threshold
    expect(strict).toContain(3);
  });

  it("returns [] when there is no series (no tracks)", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(userInstance(skel, [
      [0, 0],
      [5, 0],
    ]));
    const labels = makeLabels(video, skel, [lf]); // no tracks
    expect(velocityFrames(labels, video, 0, 0.1)).toEqual([]);
  });

  it("returns [] for a single labeled frame", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");
    const lf = new LabeledFrame({ video, frameIdx: 0 });
    lf.instances.push(
      userInstance(
        skel,
        [
          [0, 0],
          [5, 0],
        ],
        track,
      ),
    );
    const labels = makeLabels(video, skel, [lf], [track]);
    // A single tracked frame yields a degenerate (or empty) series with no
    // motion above any relative threshold.
    expect(velocityFrames(labels, video, 0, 0.1)).toEqual([]);
  });

  it("returns [] on a true no-motion series (span 0)", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");
    const frames: LabeledFrame[] = [];
    // primary node never moves -> displacement series is all-equal (span 0).
    for (let f = 0; f < 4; f++) {
      const lf = new LabeledFrame({ video, frameIdx: f });
      lf.instances.push(
        userInstance(
          skel,
          [
            [10, 10],
            [15, 10],
          ],
          track,
        ),
      );
      frames.push(lf);
    }
    const labels = makeLabels(video, skel, frames, [track]);
    // span = 0 -> (value - min) > 0 is never true for any threshold.
    expect(velocityFrames(labels, video, 0, 0.1)).toEqual([]);
  });
});

describe("maxDisplacementFrames", () => {
  /**
   * Two-frame project where a tracked instance's nodes jump by a large
   * amount; the later frame index should be returned when mean node
   * displacement exceeds the threshold.
   */
  it("returns the later frame when mean node displacement > threshold", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");

    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(
      userInstance(
        skel,
        [
          [0, 0],
          [0, 0],
        ],
        track,
      ),
    );
    const lf1 = new LabeledFrame({ video, frameIdx: 1 });
    lf1.instances.push(
      userInstance(
        skel,
        [
          [100, 0],
          [100, 0],
        ],
        track,
      ),
    );
    const labels = makeLabels(video, skel, [lf0, lf1], [track]);
    // mean node displacement = 100 > 10 -> include later frame index 1
    expect(maxDisplacementFrames(labels, video, 10)).toEqual([1]);
  });

  it("excludes the frame when displacement <= threshold", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");

    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(
      userInstance(
        skel,
        [
          [0, 0],
          [0, 0],
        ],
        track,
      ),
    );
    const lf1 = new LabeledFrame({ video, frameIdx: 1 });
    lf1.instances.push(
      userInstance(
        skel,
        [
          [3, 0],
          [3, 0],
        ],
        track,
      ),
    );
    const labels = makeLabels(video, skel, [lf0, lf1], [track]);
    // mean node displacement = 3, threshold 10 -> excluded
    expect(maxDisplacementFrames(labels, video, 10)).toEqual([]);
  });

  it("returns [] when fewer than 2 frames", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const track = new Track("t0");
    const lf0 = new LabeledFrame({ video, frameIdx: 0 });
    lf0.instances.push(
      userInstance(
        skel,
        [
          [0, 0],
          [0, 0],
        ],
        track,
      ),
    );
    const labels = makeLabels(video, skel, [lf0], [track]);
    expect(maxDisplacementFrames(labels, video, 10)).toEqual([]);
  });
});

describe("sampleFrames", () => {
  it("stride: deterministic, evenly spaced, capped at perVideo", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []); // empty suggestions
    labels.suggestions = [];
    // n=100, perVideo=5 -> inc=floor(100/5)=20 -> 0,20,40,60,80
    const out = sampleFrames(labels, video, 5, "stride", null, Math.random);
    expect(out).toEqual([0, 20, 40, 60, 80]);
  });

  it("random: reproducible with an injected deterministic rng", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    // A simple deterministic LCG-like rng.
    function makeRng(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }
    const a = sampleFrames(labels, video, 7, "random", null, makeRng(42));
    const b = sampleFrames(labels, video, 7, "random", null, makeRng(42));
    expect(a).toEqual(b);
    expect(a.length).toBe(7);
    // unique
    expect(new Set(a).size).toBe(a.length);
  });

  it("random: returns all when n <= perVideo", () => {
    const video = makeVideo(4);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    const out = sampleFrames(labels, video, 10, "random", null, Math.random);
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("excludes frames already present in labels.suggestions for that video", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [
      { video, frameIdx: 0 } as SuggestionFrame,
      { video, frameIdx: 20 } as SuggestionFrame,
    ];
    // stride candidates exclude 0 and 20; the remaining 98 candidates
    // (1..19,21..99) are strided.
    const out = sampleFrames(labels, video, 5, "stride", null, Math.random);
    expect(out).not.toContain(0);
    expect(out).not.toContain(20);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("respects a candidate range", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    // 1-based range 10..20 -> 0-based candidates 9..19 (11 frames)
    const out = sampleFrames(
      labels,
      video,
      5,
      "stride",
      { frameFrom: 10, frameTo: 20 },
      Math.random,
    );
    for (const f of out) {
      expect(f).toBeGreaterThanOrEqual(9);
      expect(f).toBeLessThanOrEqual(19);
    }
  });

  it("returns [] for perVideo <= 0 (stride and random)", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    expect(sampleFrames(labels, video, 0, "stride", null, Math.random)).toEqual(
      [],
    );
    expect(sampleFrames(labels, video, -3, "random", null, Math.random)).toEqual(
      [],
    );
  });
});

describe("applyFrameRangePostFilter", () => {
  it("keeps from-1 <= frameIdx < to when enabled", () => {
    const frames = [0, 5, 9, 10, 50];
    // 1-based from=6, to=11 -> keep 5 <= idx < 11 -> [5, 9, 10]
    expect(
      applyFrameRangePostFilter(frames, {
        enabled: true,
        frameFrom: 6,
        frameTo: 11,
      }),
    ).toEqual([5, 9, 10]);
  });

  it("is a no-op when disabled", () => {
    const frames = [0, 5, 9, 10, 50];
    expect(
      applyFrameRangePostFilter(frames, {
        enabled: false,
        frameFrom: 6,
        frameTo: 11,
      }),
    ).toEqual(frames);
  });
});

describe("generateSuggestionFrames", () => {
  it("dispatches frame_chunk and is exempt from the global range filter", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = makeLabels(video, skel, []);
    const out = generateSuggestionFrames(labels, {
      method: "frame_chunk",
      videos: [video],
      frameFrom: 3,
      frameTo: 7,
      // a frame range that would otherwise drop everything is ignored for frame_chunk
      frameRange: { enabled: true, frameFrom: 90, frameTo: 95 },
    });
    expect(out.map((s) => s.frameIdx)).toEqual([2, 3, 4, 5, 6]);
    for (const s of out) expect(s.video).toBe(video);
  });

  it("applies the global range filter to prediction_score", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const frames: LabeledFrame[] = [];
    for (const idx of [2, 50]) {
      const lf = new LabeledFrame({ video, frameIdx: idx });
      lf.instances.push(predictedInstance(skel, 1.0));
      frames.push(lf);
    }
    const labels = makeLabels(video, skel, frames);
    const out = generateSuggestionFrames(labels, {
      method: "prediction_score",
      videos: [video],
      scoreLimit: 3,
      instanceLimitLower: 1,
      instanceLimitUpper: 2,
      // 1-based 1..10 -> keep 0 <= idx < 10 -> only frame 2 survives
      frameRange: { enabled: true, frameFrom: 1, frameTo: 10 },
    });
    expect(out.map((s) => s.frameIdx)).toEqual([2]);
  });

  it("honors the videos subset (Target)", () => {
    const skel = makeSkeleton();
    const v1 = makeVideo(100, "v1.mp4");
    const v2 = makeVideo(100, "v2.mp4");
    const labels = new Labels({
      videos: [v1, v2],
      skeletons: [skel],
    });
    labels.suggestions = [];
    // Target only v2.
    const out = generateSuggestionFrames(labels, {
      method: "frame_chunk",
      videos: [v2],
      frameFrom: 1,
      frameTo: 3,
    });
    expect(out.every((s) => s.video === v2)).toBe(true);
    expect(out.map((s) => s.frameIdx)).toEqual([0, 1, 2]);
  });

  it("dedupes the same video+frameIdx within the produced list", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = makeLabels(video, skel, []);
    // Same video passed twice in the target set should not duplicate frames.
    const out = generateSuggestionFrames(labels, {
      method: "frame_chunk",
      videos: [video, video],
      frameFrom: 1,
      frameTo: 3,
    });
    expect(out.map((s) => s.frameIdx)).toEqual([0, 1, 2]);
  });

  it("dispatches stride sampling and is exempt from the range filter", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = makeLabels(video, skel, []);
    labels.suggestions = [];
    const out = generateSuggestionFrames(labels, {
      method: "stride",
      videos: [video],
      perVideo: 5,
      // would drop everything if applied, but stride is exempt from the global filter
      frameRange: { enabled: false, frameFrom: 90, frameTo: 95 },
    });
    expect(out.map((s) => s.frameIdx)).toEqual([0, 20, 40, 60, 80]);
  });

  it("produces nothing for stride with perVideo <= 0", () => {
    const skel = makeSkeleton();
    const video = makeVideo(100);
    const labels = makeLabels(video, skel, []);
    labels.suggestions = [];
    const out = generateSuggestionFrames(labels, {
      method: "stride",
      videos: [video],
      perVideo: 0,
    });
    expect(out).toEqual([]);
  });
});

/** A deterministic LCG so jittered sampling is reproducible in assertions. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("sampleFrames spread (stratified/jittered)", () => {
  it("returns exactly perVideo unique picks, one per equal-width bin", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    const out = sampleFrames(labels, video, 10, "spread", null, makeRng(7));

    expect(out.length).toBe(10);
    expect(new Set(out).size).toBe(10); // bins are disjoint
    expect([...out].sort((a, b) => a - b)).toEqual(out); // ascending
    // n=100, 10 bins -> bin i covers [10i, 10i+10)
    out.forEach((f, i) => {
      expect(f).toBeGreaterThanOrEqual(i * 10);
      expect(f).toBeLessThan((i + 1) * 10);
    });
  });

  it("covers the whole video — unlike random, no bin is ever left empty", () => {
    const video = makeVideo(1000);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    // Every decile must be represented, for any seed.
    for (const seed of [1, 42, 99, 12345]) {
      const out = sampleFrames(labels, video, 10, "spread", null, makeRng(seed));
      const deciles = new Set(out.map((f) => Math.floor(f / 100)));
      expect(deciles.size).toBe(10);
    }
  });

  it("is not strictly periodic, so it can't alias a periodic recording", () => {
    const video = makeVideo(1000);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    const out = sampleFrames(labels, video, 20, "spread", null, makeRng(3));
    const gaps = new Set(out.slice(1).map((f, i) => f - out[i]));
    expect(gaps.size).toBeGreaterThan(1); // stride would give exactly one gap
  });

  it("is reproducible with an injected rng and returns all when n <= perVideo", () => {
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    const big = makeVideo(100);
    expect(sampleFrames(labels, big, 9, "spread", null, makeRng(5))).toEqual(
      sampleFrames(labels, big, 9, "spread", null, makeRng(5)),
    );
    const tiny = makeVideo(4);
    expect(sampleFrames(labels, tiny, 10, "spread", null, makeRng(5))).toEqual([0, 1, 2, 3]);
  });

  it("spreads over the REMAINING candidates, so a second batch fills the gaps", () => {
    const video = makeVideo(100);
    const labels = makeLabels(makeVideo(0), makeSkeleton(), []);
    labels.suggestions = [];
    const first = sampleFrames(labels, video, 10, "spread", null, makeRng(11));
    labels.suggestions = first.map((frameIdx) => ({ video, frameIdx }) as SuggestionFrame);
    const second = sampleFrames(labels, video, 10, "spread", null, makeRng(11));
    expect(second.length).toBe(10);
    expect(second.some((f) => first.includes(f))).toBe(false);
  });
});

describe("allocateAcrossVideos", () => {
  it("splits a TOTAL budget instead of handing each video the full count", () => {
    const videos = [makeVideo(1000, "a.mp4"), makeVideo(1000, "b.mp4"), makeVideo(1000, "c.mp4")];
    const alloc = allocateAcrossVideos(videos, 99);
    expect(alloc).toEqual([33, 33, 33]);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(99);
  });

  it("weights longer videos more heavily and still sums to the budget", () => {
    const videos = [makeVideo(900, "long.mp4"), makeVideo(100, "short.mp4")];
    const alloc = allocateAcrossVideos(videos, 100);
    expect(alloc).toEqual([90, 10]);
  });

  it("hands the flooring leftover to the largest fractional shares", () => {
    const videos = [makeVideo(100, "a.mp4"), makeVideo(100, "b.mp4"), makeVideo(100, "c.mp4")];
    const alloc = allocateAcrossVideos(videos, 10);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(10);
    expect([...alloc].sort()).toEqual([3, 3, 4]);
  });

  it("gives every sampleable video at least one frame", () => {
    const videos = [makeVideo(10000, "long.mp4"), makeVideo(5, "blink.mp4")];
    const alloc = allocateAcrossVideos(videos, 100);
    expect(alloc[1]).toBeGreaterThanOrEqual(1);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(100);
  });

  it("trims back to the exact budget when the min-1 floor overshoots", () => {
    // 1 long video + 3 one-frame videos, budget 4: proportional shares are
    // ~3.99/0.004/0.004/0.004, so flooring + the min-1 floor wants 3+1+1+1 = 6.
    const videos = [
      makeVideo(1000, "long.mp4"),
      makeVideo(1, "x.mp4"),
      makeVideo(1, "y.mp4"),
      makeVideo(1, "z.mp4"),
    ];
    const alloc = allocateAcrossVideos(videos, 4);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(4);
    expect(alloc).toEqual([1, 1, 1, 1]);
  });

  it("gives one each to the longest when there are fewer frames than videos", () => {
    const videos = [makeVideo(10, "a.mp4"), makeVideo(1000, "b.mp4"), makeVideo(500, "c.mp4")];
    expect(allocateAcrossVideos(videos, 2)).toEqual([0, 1, 1]);
  });

  it("skips videos of unknown length and handles a non-positive budget", () => {
    const known = makeVideo(100, "known.mp4");
    const unknown = new Video({ filename: "u.mp4", openBackend: false });
    expect(allocateAcrossVideos([known, unknown], 10)).toEqual([10, 0]);
    expect(allocateAcrossVideos([known], 0)).toEqual([0]);
    expect(allocateAcrossVideos([unknown], 10)).toEqual([0]);
  });
});

describe("sampleFramesAcrossVideos", () => {
  it("returns `total` frames for the PROJECT, not total per video", () => {
    const videos = [makeVideo(500, "a.mp4"), makeVideo(500, "b.mp4"), makeVideo(500, "c.mp4")];
    const labels = new Labels({ videos, skeletons: [makeSkeleton()] });
    labels.suggestions = [];
    const out = sampleFramesAcrossVideos(labels, videos, 30, "spread", null, makeRng(1));

    expect(out.length).toBe(30); // NOT 90
    for (const video of videos) {
      expect(out.filter((s) => s.video === video).length).toBe(10);
    }
  });

  it("spreads each video's share over that video's whole length", () => {
    const videos = [makeVideo(1000, "a.mp4"), makeVideo(1000, "b.mp4")];
    const labels = new Labels({ videos, skeletons: [makeSkeleton()] });
    labels.suggestions = [];
    const out = sampleFramesAcrossVideos(labels, videos, 20, "spread", null, makeRng(2));
    for (const video of videos) {
      const idxs = out.filter((s) => s.video === video).map((s) => s.frameIdx);
      expect(idxs.length).toBe(10);
      expect(Math.min(...idxs)).toBeLessThan(100);
      expect(Math.max(...idxs)).toBeGreaterThanOrEqual(900);
    }
  });

  it("comes in under budget rather than re-offering queued frames", () => {
    const video = makeVideo(12);
    const labels = new Labels({ videos: [video], skeletons: [makeSkeleton()] });
    labels.suggestions = Array.from(
      { length: 10 },
      (_, i) => ({ video, frameIdx: i }) as SuggestionFrame,
    );
    const out = sampleFramesAcrossVideos(labels, [video], 8, "spread", null, makeRng(4));
    expect(out.map((s) => s.frameIdx).sort((a, b) => a - b)).toEqual([10, 11]);
  });
});
