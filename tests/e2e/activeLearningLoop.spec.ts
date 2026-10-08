import { test, expect } from "@playwright/test";
import fs from "fs/promises";

// The continuous loop in the real app: a round's predictions land → the review
// starts by itself (budgeted) → the Loop card tracks it → finishing the sweep
// counts down to the next round, which "Not now" cancels. Training itself needs
// sleap-nn on the desktop, so the round's "predictions landed" moment is driven
// through the same entry point the engine uses (`offerReview`).
const PRED_SLP = "/Users/than/work/sleap-io.js/tests/data/slp/centered_pair_predictions.slp";
const PRED_MP4 = "/Users/than/work/sleap-io.js/tests/data/videos/centered_pair_low_quality.mp4";

async function fixturesPresent(): Promise<boolean> {
  try {
    await Promise.all([fs.access(PRED_SLP), fs.access(PRED_MP4)]);
    return true;
  } catch {
    return false;
  }
}

test("AL loop: auto-review a round, Loop card, countdown to the next round", async ({ page }) => {
  test.skip(!(await fixturesPresent()), "needs a sibling sleap-io.js checkout for the fixtures");

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.sleap?.loadProjectFromFile), null, { timeout: 30000 });

  const slpBytes = await fs.readFile(PRED_SLP);
  await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], "centered_pair_predictions.slp");
    await window.sleap.loadProjectFromFile(file);
  }, Array.from(slpBytes));
  await page.waitForFunction(() => window.sleap.store.getState().projectLoaded === true, null, { timeout: 30000 });

  const mp4Bytes = await fs.readFile(PRED_MP4);
  await page.evaluate(async (arr) => {
    const s = window.sleap.store.getState();
    const v = s.labels!.videos[0];
    v.backend = new window.sleap.Mp4BoxVideoBackend(
      new File([new Uint8Array(arr)], "centered_pair_low_quality.mp4", { type: "video/mp4" }),
    );
    v.filename = "centered_pair_low_quality.mp4";
    s.setVideo(v);
    s.setFrameIdx(0);
    await new Promise((r) => setTimeout(r, 1500));
  }, Array.from(mp4Bytes));

  // A workflow with a small per-round budget, and round 1 "trained".
  const queued = await page.evaluate(() => {
    const { store, buildRoundQueue, offerReview, frameKey } = window.sleap.activeLearning;
    const al = store.getState();
    al.useDefaultConfig();
    const cfg = store.getState().config!;
    store.getState().setConfig({ ...cfg, mine: { ...cfg.mine, reviewBudget: 5 } }, undefined, { keepProgress: true });
    store.getState().recordTraining({
      round: 1,
      modelType: "top_down",
      models: [
        { slot: "centroid", dir: "/models/r1.centroid" },
        { slot: "centered_instance", dir: "/models/r1.centered_instance" },
      ],
      trainedAt: new Date().toISOString(),
      fineTuned: false,
    });
    store.getState().markVideosPredicted(["centered_pair_low_quality.mp4"]);

    // The round predicted frames 0–599: build its queue and hand it over.
    const labels = window.sleap.store.getState().labels!;
    const frames = new Set<string>();
    for (let f = 0; f < 600; f++) frames.add(frameKey(0, f));
    const q = buildRoundQueue(labels, frames, store.getState().config!.mine);
    offerReview(1, q, q.length);
    return {
      len: q.length,
      inRound: q.every((it) => it.frameIdx < 600),
      mode: window.sleap.store.getState().labelingMode,
      stage: store.getState().stage,
    };
  });
  expect(queued.len).toBe(5);
  expect(queued.inRound).toBe(true);
  expect(queued.mode).toBe("correct"); // idle → the review started by itself
  expect(queued.stage).toBe("reviewing");

  // The Loop card on the AL panel's Correct tab.
  await page.evaluate(() => {
    window.sleap.store.setState({
      sidebarOpenPanels: ["active-learning"],
      sidebarCollapsedSections: [],
      sidebarCollapsed: false,
    });
  });
  await page.getByRole("tab", { name: /^Correct/ }).click();
  await expect(page.getByText(/Loop · round 1 \/ 5/)).toBeVisible();
  await expect(page.getByText("reviewing", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/al-loop-01-review.png" });

  // Accept all five (Space), then the countdown to round 2 appears.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 5; i++) {
    const c = await page.evaluate(() => window.sleap.store.getState().correctCursor);
    await page.keyboard.press("Space");
    await page.waitForFunction((cur) => window.sleap.store.getState().correctCursor > cur, c, { timeout: 15000 });
  }
  const toastText = page.getByText(/Round 1 reviewed\. Round 2 starts training in 5 s\./);
  await expect(toastText).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: "/tmp/al-loop-02-countdown.png" });

  // "Not now" cancels: the loop pauses and round 1 stays round 1.
  await page.getByRole("button", { name: "Not now" }).click();
  await page.waitForTimeout(5500);
  const after = await page.evaluate(() => ({
    round: window.sleap.activeLearning.store.getState().round,
    stage: window.sleap.activeLearning.store.getState().stage,
  }));
  expect(after).toEqual({ round: 1, stage: "idle" });
  await page.screenshot({ path: "/tmp/al-loop-03-paused.png" });

  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
