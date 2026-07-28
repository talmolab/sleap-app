import { test, expect } from "@playwright/test";
import fs from "fs/promises";

/**
 * Two Phase-1/2 quality-of-life behaviours that only a real browser proves,
 * because both live in the panel/keyboard wiring rather than the pure engine:
 *
 *  1. "Add frames" spends a TOTAL budget across the project's videos (it used to
 *     pass the number through as a per-video count, so an N-video project got
 *     N × the frames asked for) and spreads each video's share evenly.
 *  2. ⇧S in the keypoint sweep skips the WHOLE instance — every node decided at
 *     once, centroid kept — versus `s`, which skips one node and leaves it open.
 */
const SLP = "/Users/than/work/phase3-demo/al_e2e2.slp";

async function fixturePresent(): Promise<boolean> {
  try {
    await fs.access(SLP);
    return true;
  } catch {
    return false;
  }
}

/** Open the demo project and the Active-Learning panel. */
async function openProject(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.sleap?.loadProjectFromFile), null, {
    timeout: 30000,
  });
  const bytes = await fs.readFile(SLP);
  await page.evaluate(async (arr) => {
    await window.sleap.loadProjectFromFile(new File([new Uint8Array(arr)], "al_e2e2.slp"));
  }, Array.from(bytes));
  await page.waitForFunction(() => window.sleap.store.getState().projectLoaded === true, null, {
    timeout: 30000,
  });
  await page.evaluate(() => {
    window.sleap.store.setState({
      sidebarOpenPanels: ["active-learning"],
      sidebarCollapsedSections: [],
      sidebarCollapsed: false,
    });
  });
  await page.waitForSelector("[role=tablist]", { timeout: 15000 });
}

test("Add frames spends a total budget across videos, spread evenly", async ({ page }) => {
  test.skip(!(await fixturePresent()), "needs the local active-learning demo project");

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openProject(page);

  // Give the project a SECOND video, so "total" and "per video" differ. The Video
  // class isn't on window.sleap, so reach it through the loaded one's prototype.
  const videoCount = await page.evaluate(() => {
    const labels = window.sleap.store.getState().labels!;
    const first = labels.videos[0] as unknown as { shape: number[] };
    const Ctor = Object.getPrototypeOf(labels.videos[0]).constructor as new (o: object) => never;
    labels.videos.push(
      new Ctor({
        filename: "second.mp4",
        backendMetadata: { shape: first.shape },
        openBackend: false,
      }),
    );
    labels.suggestions = [];
    window.sleap.store.getState().bumpOverlayVersion();
    return labels.videos.length;
  });
  expect(videoCount).toBe(2);

  await page.getByRole("tab", { name: /^Localize$/ }).click();
  const countInput = page.getByLabel("Frames to add in total");
  await countInput.fill("30");
  await page.getByRole("button", { name: /^Add frames$/ }).click();

  const first = await page.evaluate(() => {
    const labels = window.sleap.store.getState().labels!;
    const perVideo = labels.videos.map((v) =>
      labels.suggestions.filter((s) => s.video === v).map((s) => s.frameIdx),
    );
    return { total: labels.suggestions.length, perVideo, len: labels.videos[0].shape![0] };
  });

  // The whole point: 30 total, not 30 per video.
  expect(first.total).toBe(30);
  expect(first.perVideo[0].length).toBe(15);
  expect(first.perVideo[1].length).toBe(15);

  // Evenly spread, not clumped: with suggestions cleared every frame is a
  // candidate, so pick i must fall in the i-th of 15 equal bins over the video —
  // one per bin, covering the whole thing. And (unlike stride) the picks must not
  // sit on one fixed period.
  for (const picks of first.perVideo) {
    const sorted = [...picks].sort((a, b) => a - b);
    expect(sorted).toEqual(picks); // ascending
    expect(new Set(picks).size).toBe(picks.length); // unique
    picks.forEach((f, i) => {
      expect(f).toBeGreaterThanOrEqual(Math.floor((i * first.len) / 15));
      expect(f).toBeLessThan(Math.floor(((i + 1) * first.len) / 15));
    });
    const gaps = new Set(sorted.slice(1).map((f, i) => f - sorted[i]));
    expect(gaps.size).toBeGreaterThan(1); // jittered, not periodic
  }

  // A second click ADDS a batch in the gaps instead of re-offering the same pool.
  await page.getByRole("button", { name: /^Add frames$/ }).click();
  const second = await page.evaluate(() => {
    const labels = window.sleap.store.getState().labels!;
    return {
      total: labels.suggestions.length,
      unique: new Set(labels.suggestions.map((s) => `${labels.videos.indexOf(s.video)}:${s.frameIdx}`))
        .size,
    };
  });
  expect(second.total).toBe(60);
  expect(second.unique).toBe(60); // no frame offered twice

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});

test("Shift+S skips the whole instance in the keypoint sweep", async ({ page }) => {
  test.skip(!(await fixturePresent()), "needs the local active-learning demo project");

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openProject(page);

  // Start the sweep through the real UI.
  await page.getByRole("tab", { name: /^Keypoints$/ }).click();
  const startBtn = page.getByRole("button", { name: /^Label keypoints on/i });
  await expect(startBtn).toBeEnabled({ timeout: 15000 });
  await startBtn.click();
  await page.waitForFunction(
    () => window.sleap.store.getState().labelingMode === "keypointPass",
    null,
    { timeout: 15000 },
  );

  const before = await page.evaluate(() => {
    const s = window.sleap.store.getState();
    const cur = s.passCursor!;
    const item = s.passWorkList[cur.itemIdx];
    const lf = s.labels!.find({ video: s.labels!.videos[item.videoIdx], frameIdx: item.frameIdx })[0];
    return {
      cursor: cur,
      itemCount: s.passWorkList.length,
      frameIdx: item.frameIdx,
      instanceIdx: item.instanceIdx,
      decided: lf.instances[item.instanceIdx].points.filter((p) => p.complete).length,
      nodeCount: lf.instances[item.instanceIdx].points.length,
      centroids: lf.centroids.length,
    };
  });
  expect(before.itemCount).toBeGreaterThan(1);
  expect(before.decided).toBeLessThan(before.nodeCount);

  // `s` alone must NOT decide anything — it only moves the cursor on.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("s");
  await page.waitForFunction(
    (c) => window.sleap.store.getState().passCursor?.nodeIdx !== c,
    before.cursor.nodeIdx,
    { timeout: 15000 },
  );
  const afterNodeSkip = await page.evaluate((b) => {
    const s = window.sleap.store.getState();
    const lf = s.labels!.find({ video: s.labels!.videos[0], frameIdx: b.frameIdx })[0];
    return lf.instances[b.instanceIdx].points.filter((p) => p.complete).length;
  }, before);
  expect(afterNodeSkip).toBe(before.decided);

  // Shift+S decides every node on this animal and moves to the next item.
  await page.keyboard.press("Shift+S");
  await page.waitForFunction(
    (c) => window.sleap.store.getState().passCursor?.itemIdx !== c,
    before.cursor.itemIdx,
    { timeout: 15000 },
  );

  const after = await page.evaluate((b) => {
    const s = window.sleap.store.getState();
    const lf = s.labels!.find({ video: s.labels!.videos[0], frameIdx: b.frameIdx })[0];
    const inst = lf.instances[b.instanceIdx];
    return {
      cursor: s.passCursor,
      allDecided: inst.points.every((p) => p.complete),
      anyPlaced: inst.points.some((p) => Number.isFinite(p.xy[0])),
      centroids: lf.centroids.length,
      hasChanges: s.hasChanges,
    };
  }, before);

  expect(after.allDecided, "every node on the skipped animal is decided").toBe(true);
  expect(after.anyPlaced, "no label was invented").toBe(false);
  expect(after.centroids, "the centroid survives the skip").toBe(before.centroids);
  expect(after.cursor!.itemIdx).toBeGreaterThan(before.cursor.itemIdx);
  expect(after.hasChanges).toBe(true);

  // The skip has to hold across a RESUME: stop the sweep, then "Resume where I
  // left off" must land somewhere other than the animal we just wrote off.
  await page.getByRole("button", { name: /^Stop labeling keypoints$/ }).click();
  await page.waitForFunction(
    () => window.sleap.store.getState().labelingMode === "select",
    null,
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: /^Resume where I left off/ }).click();
  await page.waitForFunction(
    () => window.sleap.store.getState().labelingMode === "keypointPass",
    null,
    { timeout: 15000 },
  );
  const resumed = await page.evaluate((b) => {
    const s = window.sleap.store.getState();
    const cur = s.passCursor!;
    const item = s.passWorkList[cur.itemIdx];
    return { frameIdx: item.frameIdx, instanceIdx: item.instanceIdx, was: b };
  }, before);
  expect(
    resumed.frameIdx === before.frameIdx && resumed.instanceIdx === before.instanceIdx,
    "resume must not land back on the skipped animal",
  ).toBe(false);

  // Undo puts it back.
  await page.evaluate(() => window.sleap.commandContext.undo());
  const undone = await page.evaluate((b) => {
    const s = window.sleap.store.getState();
    const lf = s.labels!.find({ video: s.labels!.videos[0], frameIdx: b.frameIdx })[0];
    return lf.instances[b.instanceIdx].points.every((p) => p.complete);
  }, before);
  expect(undone, "undo restores the skipped instance").toBe(false);

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
