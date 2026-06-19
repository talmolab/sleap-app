/**
 * Render test for the Frames panel's row virtualization (#160).
 *
 * The panel used to render one DOM row per labeled frame (`sortedRows.map(...)`),
 * which hangs on large `.slp` files. It now renders only a windowed slice plus
 * top/bottom spacer rows (the pure windowing math lives in
 * `src/lib/virtualWindow.ts` and is unit-tested separately).
 *
 * This test seeds a project with many labeled frames and asserts that:
 *  - only a bounded subset of data rows is rendered (virtualization works),
 *  - the header count badge still reflects the FULL seeded count,
 *  - clicking a rendered row still drives navigation,
 *  - sorting still reorders the rendered window.
 *
 * NOTE ON LAYOUT: happy-dom has no real layout engine, so `clientHeight` /
 * `offsetHeight` report 0. That is exactly why the component keeps positive
 * defaults (viewportHeight 400, rowHeight 22) — windowing stays active even
 * without measured layout. We therefore rely on those defaults here and do not
 * assert on measured pixel geometry.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useAppStore } from "@/stores/appStore";
import {
  Labels,
  Instance,
  LabeledFrame,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

const TOTAL_FRAMES = 600;

/**
 * Build a project with one backend-less video and many labeled frames, each
 * carrying a single user instance (empty LabeledFrames are skipped by the
 * panel, so every frame needs an instance to produce a row).
 */
function seedManyFrames(numFrames = TOTAL_FRAMES) {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "test" });
  skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);

  // Real (backend-less) Video with an explicit shape so frame indices are not
  // clamped by setFrameIdx (shape[0] = 2000 > our max frame index).
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [2000, 480, 640, 3] },
    openBackend: false,
  });

  const labels = new Labels({ videos: [video], skeletons: [skeleton] });

  for (let f = 0; f < numFrames; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f });
    const inst = Instance.empty({ skeleton });
    inst.points[0].xy = [f, f];
    inst.points[0].visible = true;
    inst.points[1].xy = [f + 1, f + 1];
    inst.points[1].visible = true;
    lf.instances.push(inst);
    labels.labeledFrames.push(lf);
  }

  return { labels, video, skeleton };
}

/** Render the panel against a freshly seeded store. */
async function renderPanel(numFrames = TOTAL_FRAMES) {
  const { labels, video } = seedManyFrames(numFrames);
  useAppStore.getState().setLabels(labels, "test.slp");
  useAppStore.getState().setVideo(video);
  useAppStore.getState().setFrameIdx(0);

  const { FramesPanel } = await import("@/components/panels/FramesPanel");
  const utils = render(<FramesPanel />);
  return { ...utils, labels, video };
}

/** All rendered body rows that carry data (exclude aria-hidden spacers). */
function dataRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("tbody tr:not([aria-hidden])")
  );
}

/** The numeric "Frame" value of a rendered data row (the right-aligned cell). */
function rowFrame(row: HTMLElement): number {
  // Columns: Video | Frame | User | Pred | Score (default visible).
  const cells = row.querySelectorAll("td");
  return Number(cells[1].textContent);
}

describe("FramesPanel virtualization (#160)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders only a bounded subset of rows, not all of them", async () => {
    await renderPanel();

    const rendered = dataRows();
    // With 600 frames and the default 400px / 22px window + overscan, far fewer
    // than 60 rows should be in the DOM (a non-virtualized panel would have 600).
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    expect(rendered.length).toBeLessThan(TOTAL_FRAMES);
  });

  it("shows the FULL seeded frame count in the header badge", async () => {
    await renderPanel();
    // Counts come from the full filtered/rows arrays, not the rendered subset.
    expect(screen.getAllByText(`${TOTAL_FRAMES} frames`).length).toBeGreaterThan(
      0
    );
  });

  it("navigates when a rendered data row is clicked", async () => {
    const { video } = await renderPanel();

    const rows = dataRows();
    expect(rows.length).toBeGreaterThan(1);

    // Pick a row that is not the current frame (frame 0) to see a real change.
    const target = rows[1];
    const expectedFrame = rowFrame(target);

    fireEvent.click(target);

    expect(useAppStore.getState().frameIdx).toBe(expectedFrame);
    expect(useAppStore.getState().video).toBe(video);
  });

  it("re-sorts the rendered window when the Frame header is toggled", async () => {
    await renderPanel();

    // Default sort is Frame ascending -> first rendered data row is frame 0.
    const ascFirst = rowFrame(dataRows()[0]);
    expect(ascFirst).toBe(0);

    // Click the "Frame" column header to toggle to descending.
    const frameHeader = screen
      .getAllByRole("columnheader")
      .find((h) => within(h).queryByText(/Frame/));
    expect(frameHeader).toBeTruthy();
    fireEvent.click(frameHeader!);

    const descFirst = rowFrame(dataRows()[0]);
    // Descending: the first rendered row should now be the largest frame index,
    // which differs from the ascending first row.
    expect(descFirst).not.toBe(ascFirst);
    expect(descFirst).toBe(TOTAL_FRAMES - 1);
  });

  // NOTE: We intentionally do NOT drive a real scroll event here. happy-dom
  // does not implement scroll geometry (the viewport's scrollTop is not backed
  // by layout, and a dispatched "scroll" event does not move the window in a
  // meaningful, observable way). The scroll-driven windowing path is covered by
  // the pure-math unit tests in tests/unit/virtualWindow.test.ts, which exercise
  // computeVirtualWindow across scrollTop values directly.
});
