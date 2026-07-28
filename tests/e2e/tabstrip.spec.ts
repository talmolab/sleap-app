import { test, expect } from "@playwright/test";
import fs from "fs/promises";

/**
 * Regression: the Active-Learning tab strip showed a stray VERTICAL scrollbar.
 *
 * The cause was `overflow-x-auto` on the tab list: per CSS, if one axis is not
 * `visible` the other computes to `auto`, so the strip became vertically
 * scrollable too — and the horizontal scrollbar gutter then shrank the content
 * box until the triggers no longer fit, which is what made the scrollbar appear.
 *
 * Asserted behaviourally (can a user scroll it?) rather than via `scrollHeight`:
 * on a non-scrolling box `scrollHeight` merely reports the content bounding box,
 * which can exceed `clientHeight` with no scrollbar existing at all.
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

test("AL tab strip cannot scroll vertically", async ({ page }) => {
  test.skip(!(await fixturePresent()), "needs the local active-learning demo project");

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

  // Open the Active-Learning panel and expand its section (stacked-panel model).
  await page.evaluate(() => {
    window.sleap.store.setState({
      sidebarOpenPanels: ["active-learning"],
      sidebarCollapsedSections: [],
      sidebarCollapsed: false,
    });
  });
  await page.waitForSelector("[role=tablist]", { timeout: 15000 });
  await page.waitForTimeout(500);

  const m = await page.evaluate(() => {
    const tl = document.querySelector("[role=tablist]") as HTMLElement;
    tl.scrollTop = 999; // a scrollable box would move; this one must not
    const cs = getComputedStyle(tl);
    const lr = tl.getBoundingClientRect();
    return {
      scrollTopAfter: tl.scrollTop,
      overflowY: cs.overflowY,
      tabCount: tl.querySelectorAll("[role=tab]").length,
      // Every trigger must sit fully inside the strip — no clipped underline.
      triggersFit: Array.from(tl.querySelectorAll("[role=tab]")).every((t) => {
        const r = (t as HTMLElement).getBoundingClientRect();
        return r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5;
      }),
    };
  });

  expect(m.tabCount).toBe(4);
  expect(m.overflowY, "vertical axis must not be scrollable").not.toBe("auto");
  expect(m.overflowY).not.toBe("scroll");
  expect(m.scrollTopAfter, "tab strip must not scroll vertically").toBe(0);
  expect(m.triggersFit, "tab triggers must not be clipped by the strip").toBe(true);
});
