import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

// This spec runs as an ES module (no CommonJS __dirname); derive it from the URL.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(dirname, "../fixtures/minimal_instance.slp");

// GUI regression: the app boots, loads a project, and renders the editor —
// including the pieces added for the active-learning work (AppShell with the
// seed/training bars, the Active Learning panel in the registry). The load goes
// through the exposed `window.sleap.loadProjectFromFile` debug API because the
// browser build opens files via the File System Access picker, which Playwright
// can't drive.
test("app boots, loads a project, and renders the editor", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");

  // App shell + debug API are ready.
  await page.waitForFunction(() => Boolean(window.sleap?.loadProjectFromFile), null, {
    timeout: 20000,
  });

  // Load the fixture via the same code path the UI uses.
  const bytes = await fs.readFile(FIXTURE_PATH);
  await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], "minimal_instance.slp");
    await window.sleap.loadProjectFromFile(file);
  }, Array.from(bytes));

  // Project loaded into the store.
  await page.waitForFunction(() => window.sleap.store.getState().projectLoaded === true, null, {
    timeout: 20000,
  });

  // The editor rendered its canvas layer (the labeling surface).
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20000 });

  // The Active Learning panel is registered in the sidebar (the AL feature).
  const alButton = page.getByRole("button", { name: /active learning/i });
  await expect(alButton).toHaveCount(1);

  // No uncaught errors during boot + load + render.
  expect(pageErrors).toEqual([]);
});
