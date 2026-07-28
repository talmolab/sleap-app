import { test, expect } from "@playwright/test";
import fs from "fs/promises";

// A real predictions file: 1100 frames, 2274 PredictedInstances carrying
// per-point confidence. Its video path inside the .slp is relative and does not
// resolve, so the test attaches the real mp4 backend in-page (the same
// `new Mp4BoxVideoBackend(file)` the browser locate flow uses) — correct mode
// refuses to convert when it cannot land the target frame, which needs a real
// frame count.
const PRED_SLP = "/Users/than/work/sleap-io.js/tests/data/slp/centered_pair_predictions.slp";
const PRED_MP4 = "/Users/than/work/sleap-io.js/tests/data/videos/centered_pair_low_quality.mp4";

/** Both assets live in a sibling sleap-io.js checkout, which CI does not have. */
async function fixturesPresent(): Promise<boolean> {
  try {
    await Promise.all([fs.access(PRED_SLP), fs.access(PRED_MP4)]);
    return true;
  } catch {
    return false;
  }
}

test("Phase-3 correct mode: queue, rings, accept, skip, back, exit", async ({ page }) => {
  test.skip(
    !(await fixturesPresent()),
    "needs a sibling sleap-io.js checkout for the predictions fixture + video"
  );

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.sleap?.loadProjectFromFile), null, {
    timeout: 30000,
  });

  // 1. Open the predictions project.
  const slpBytes = await fs.readFile(PRED_SLP);
  await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], "centered_pair_predictions.slp");
    await window.sleap.loadProjectFromFile(file);
  }, Array.from(slpBytes));
  await page.waitForFunction(() => window.sleap.store.getState().projectLoaded === true, null, {
    timeout: 30000,
  });

  // 2. Attach the real video so frames decode and `video.shape` is truthful.
  const mp4Bytes = await fs.readFile(PRED_MP4);
  const shape = await page.evaluate(async (arr) => {
    const s = window.sleap.store.getState();
    const labels = s.labels!;
    const v = labels.videos[0];
    const file = new File([new Uint8Array(arr)], "centered_pair_low_quality.mp4", {
      type: "video/mp4",
    });
    v.backend = new window.sleap.Mp4BoxVideoBackend(file);
    v.filename = "centered_pair_low_quality.mp4";
    s.setVideo(v);
    s.setFrameIdx(0);
    s.bumpOverlayVersion?.();
    // Let the backend probe the container.
    await new Promise((r) => setTimeout(r, 1500));
    return window.sleap.store.getState().labels!.videos[0].shape;
  }, Array.from(mp4Bytes));
  expect(shape, "video shape must resolve for correct mode to convert").not.toBeNull();
  expect(shape![0]).toBeGreaterThan(1000);

  // 3. Enter correct mode through the real UI. "Correct predictions" is the
  // rightmost tab of the Active-Learning panel now (not a standalone sidebar
  // panel), so open that panel and select the tab.
  await page.evaluate(() => {
    window.sleap.store.setState({
      sidebarOpenPanels: ["active-learning"],
      sidebarCollapsedSections: [],
      sidebarCollapsed: false,
    });
  });
  await page.getByRole("tab", { name: /^Correct$/ }).click();
  const startBtn = page.getByRole("button", { name: /start correcting/i });
  await expect(startBtn).toBeEnabled({ timeout: 15000 });
  await startBtn.click();

  await page.waitForFunction(
    () => window.sleap.store.getState().labelingMode === "correct",
    null,
    { timeout: 15000 }
  );

  const queued = await page.evaluate(() => {
    const s = window.sleap.store.getState();
    return {
      mode: s.labelingMode,
      len: s.correctQueue.length,
      cursor: s.correctCursor,
      first: s.correctQueue[0],
      threshold: s.correctScoreThreshold,
    };
  });
  console.log("QUEUE:", JSON.stringify({ ...queued, first: queued.first }, null, 1));
  expect(queued.len).toBeGreaterThan(0);
  expect(queued.cursor).toBe(0);
  // Worst-first: the head item's worst keypoint is at/below the threshold.
  expect(queued.first.worstScore).toBeLessThanOrEqual(queued.threshold);

  // The sweep navigated to the head item's frame.
  await page.waitForFunction(
    () => {
      const s = window.sleap.store.getState();
      return s.frameIdx === s.correctQueue[s.correctCursor]?.frameIdx;
    },
    null,
    { timeout: 15000 }
  );

  await page.screenshot({ path: "/tmp/correct-mode-01-entered.png", fullPage: true });

  // 4. Accept + advance (Space) converts the prediction to a user instance.
  const before = await page.evaluate(() => {
    const s = window.sleap.store.getState();
    const it = s.correctQueue[s.correctCursor];
    const lf = s.labels!.find({ video: s.labels!.videos[it.videoIdx], frameIdx: it.frameIdx })[0];
    return {
      item: { frameIdx: it.frameIdx, instanceIdx: it.instanceIdx, worst: it.worstScore },
      ctor: lf.instances[it.instanceIdx].constructor.name,
      cursor: s.correctCursor,
    };
  });

  // Move focus off the "Start correcting" button — a focused button would
  // swallow Space as a re-activation instead of reaching the global shortcut.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Space");
  await page.waitForFunction(
    (c) => window.sleap.store.getState().correctCursor > c,
    before.cursor,
    { timeout: 15000 }
  );

  const after = await page.evaluate((it) => {
    const s = window.sleap.store.getState();
    const lf = s.labels!.find({ video: s.labels!.videos[0], frameIdx: it.frameIdx })[0];
    return { ctor: lf.instances[it.instanceIdx].constructor.name, cursor: s.correctCursor };
  }, before.item);

  console.log("ACCEPT:", JSON.stringify({ before, after }));
  expect(before.ctor).toContain("PredictedInstance");
  expect(after.ctor).toBe("_Instance"); // converted to a user instance
  expect(after.cursor).toBe(before.cursor + 1);

  // 5. Skip (S) advances WITHOUT converting.
  const skipTarget = await page.evaluate(() => {
    const s = window.sleap.store.getState();
    const it = s.correctQueue[s.correctCursor];
    return { frameIdx: it.frameIdx, instanceIdx: it.instanceIdx, cursor: s.correctCursor };
  });
  await page.keyboard.press("s");
  await page.waitForFunction(
    (c) => window.sleap.store.getState().correctCursor > c,
    skipTarget.cursor,
    { timeout: 15000 }
  );
  const afterSkip = await page.evaluate((it) => {
    const s = window.sleap.store.getState();
    const lf = s.labels!.find({ video: s.labels!.videos[0], frameIdx: it.frameIdx })[0];
    return { ctor: lf.instances[it.instanceIdx].constructor.name, cursor: s.correctCursor };
  }, skipTarget);
  console.log("SKIP:", JSON.stringify({ skipTarget, afterSkip }));
  expect(afterSkip.ctor).toContain("PredictedInstance"); // untouched
  expect(afterSkip.cursor).toBe(skipTarget.cursor + 1);

  // 6. Back (B) steps the cursor backwards.
  await page.keyboard.press("b");
  await page.waitForFunction(
    (c) => window.sleap.store.getState().correctCursor === c - 1,
    afterSkip.cursor,
    { timeout: 15000 }
  );

  await page.screenshot({ path: "/tmp/correct-mode-02-after-accept.png", fullPage: true });

  // 7. Escape exits the sweep.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.sleap.store.getState().labelingMode === "select",
    null,
    { timeout: 15000 }
  );

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
