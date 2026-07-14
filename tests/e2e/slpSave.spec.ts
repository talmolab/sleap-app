import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

// This spec runs as an ES module (no CommonJS __dirname); derive it from the URL.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(dirname, "../fixtures/minimal_instance.slp");

test("load fixture and save produces HDF5 file", async ({ page }) => {
  await page.goto("/");

  // Wait for the app to be ready
  await page.waitForSelector("text=SLEAP", { timeout: 15000 });

  // Load the fixture file via the file input (use page.setInputFiles on a file input)
  // We trigger the open dialog by dispatching a file via an injected input
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Control+o"),
  ]);
  await fileChooser.setFiles(FIXTURE_PATH);

  // Wait for the project to load (toast notification)
  await page.waitForSelector("text=Loaded", { timeout: 15000 });

  // Trigger save and capture the download
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);

  // Read the downloaded file bytes and verify HDF5 magic bytes
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  const fs = await import("fs/promises");
  const bytes = await fs.readFile(downloadPath!);

  // HDF5 files start with \x89HDF\r\n\x1a\n
  expect(bytes[0]).toBe(0x89);
  expect(bytes[1]).toBe(0x48); // H
  expect(bytes[2]).toBe(0x44); // D
  expect(bytes[3]).toBe(0x46); // F
});
