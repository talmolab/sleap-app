/**
 * Tests for the tri-state navigation domain (issue #137, imaged-frames step):
 *   - the pure `imagedFrameIndices` / `navigableDomain` helpers in
 *     src/lib/navigableFrames.ts,
 *   - the store integration where `incrementFrameIdx` honors `navigationDomain`
 *     ('all' | 'labeled' | 'imaged'), and
 *   - the persist migration from the legacy `navigateLabeledOnly` boolean.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { imagedFrameIndices, navigableDomain } from "@/lib/navigableFrames";
import { useAppStore, navigationDomainFromPersisted } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
  type VideoBackend,
} from "@talmolab/sleap-io.js";

/**
 * Build a project whose single video reports `imaged` as its embedded-image set
 * (via a stub backend exposing `frameNumbers`) and has `labeled` labeled frames.
 */
function makeProject(imaged: number[] | null, labeled: number[] = []) {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  // Only `frameNumbers` is read by Video.embeddedFrameIndices; a `null` imaged
  // set means a continuous video (no backend frame numbers).
  const backend =
    imaged === null
      ? null
      : ({
          filename: "test.pkg.slp",
          frameNumbers: imaged,
          getFrame: async () => null,
          close: () => {},
        } as unknown as VideoBackend);
  const video = new Video({
    filename: "test.pkg.slp",
    backend,
    backendMetadata: { shape: [100, 480, 640, 3] },
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton] });
  for (const f of labeled) {
    const lf = new LabeledFrame({ video, frameIdx: f });
    lf.instances.push(Instance.empty({ skeleton }));
    labels.labeledFrames.push(lf);
  }
  return { labels, video, skeleton };
}

describe("imagedFrameIndices", () => {
  it("returns the video's embedded frame set, sorted and de-duplicated", () => {
    const { video } = makeProject([20, 10, 10, 30]);
    expect(imagedFrameIndices(video)).toEqual([10, 20, 30]);
  });

  it("returns null for a continuous video (no embedded frames)", () => {
    const { video } = makeProject(null);
    expect(imagedFrameIndices(video)).toBeNull();
  });

  it("returns null for a null video", () => {
    expect(imagedFrameIndices(null)).toBeNull();
  });
});

describe("navigableDomain", () => {
  it("returns null in 'all' mode (no restriction)", () => {
    const { labels, video } = makeProject([0, 5, 10], [0, 5]);
    expect(navigableDomain(labels, video, "all")).toBeNull();
  });

  it("returns the labeled frames in 'labeled' mode", () => {
    const { labels, video } = makeProject([0, 5, 10], [5, 0]);
    expect(navigableDomain(labels, video, "labeled")).toEqual([0, 5]);
  });

  it("returns the imaged frames in 'imaged' mode", () => {
    const { labels, video } = makeProject([0, 5, 10], [5]);
    expect(navigableDomain(labels, video, "imaged")).toEqual([0, 5, 10]);
  });

  it("returns null in 'imaged' mode for a continuous video", () => {
    const { labels, video } = makeProject(null, [5]);
    expect(navigableDomain(labels, video, "imaged")).toBeNull();
  });
});

describe("incrementFrameIdx (navigationDomain)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("steps only through imaged frames in 'imaged' mode, skipping dead gaps", () => {
    const { labels } = makeProject([0, 5, 10], []);
    useAppStore.getState().setLabels(labels, "test.pkg.slp");
    useAppStore.getState().setNavigationDomain("imaged");
    useAppStore.getState().setFrameIdx(0);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(5);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(10);

    // Wraps to the first imaged frame.
    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(0);
  });

  it("uses dense stepping in 'imaged' mode for a continuous video", () => {
    const { labels } = makeProject(null, []);
    useAppStore.getState().setLabels(labels, "test.mp4");
    useAppStore.getState().setNavigationDomain("imaged");
    useAppStore.getState().setFrameIdx(5);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(6);
  });

  it("steps only through labeled frames in 'labeled' mode", () => {
    const { labels } = makeProject([0, 5, 10], [0, 10]);
    useAppStore.getState().setLabels(labels, "test.pkg.slp");
    useAppStore.getState().setNavigationDomain("labeled");
    useAppStore.getState().setFrameIdx(0);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(10);
  });

  it("uses dense stepping in the default 'all' mode", () => {
    const { labels } = makeProject([0, 5, 10], [0, 5, 10]);
    useAppStore.getState().setLabels(labels, "test.pkg.slp");
    useAppStore.getState().setFrameIdx(0);

    useAppStore.getState().incrementFrameIdx(1);
    expect(useAppStore.getState().frameIdx).toBe(1);
  });

  it("cycles the mode All -> Labeled -> Imaged -> All", () => {
    expect(useAppStore.getState().navigationDomain).toBe("all");
    useAppStore.getState().cycleNavigationDomain();
    expect(useAppStore.getState().navigationDomain).toBe("labeled");
    useAppStore.getState().cycleNavigationDomain();
    expect(useAppStore.getState().navigationDomain).toBe("imaged");
    useAppStore.getState().cycleNavigationDomain();
    expect(useAppStore.getState().navigationDomain).toBe("all");
  });
});

describe("navigationDomainFromPersisted (migration)", () => {
  it("maps the legacy navigateLabeledOnly:true to 'labeled'", () => {
    expect(navigationDomainFromPersisted({ navigateLabeledOnly: true })).toBe("labeled");
  });

  it("maps legacy navigateLabeledOnly:false / absent to 'all'", () => {
    expect(navigationDomainFromPersisted({ navigateLabeledOnly: false })).toBe("all");
    expect(navigationDomainFromPersisted({})).toBe("all");
  });

  it("prefers an explicit navigationDomain when present", () => {
    expect(
      navigationDomainFromPersisted({ navigationDomain: "imaged", navigateLabeledOnly: true }),
    ).toBe("imaged");
  });

  it("falls back to 'all' for an unknown / corrupt persisted value", () => {
    expect(navigationDomainFromPersisted({ navigationDomain: "garbage" })).toBe("all");
    expect(navigationDomainFromPersisted({ navigationDomain: "" })).toBe("all");
  });
});
