/**
 * Live check that a `.pkg.slp` can be READ AS A VIDEO in the browser.
 *
 * This is the half of `src/lib/hdf5VideoSource.ts` the unit tests can't reach:
 * it needs h5wasm in a real Web Worker plus the app's cross-origin isolation
 * headers, neither of which exists under the bun test runner. The fixture
 * (`tests/fixtures/embedded_source.pkg.slp`) is a two-video package whose first
 * video embeds frames 10/20/30 of a nominally 100-frame source — so it proves
 * the things a naive implementation gets wrong: the frame map must come from the
 * PACKAGE (not the referencing `.slp`), the seekbar extent must be the source's
 * 100 frames rather than the 3 stored ones, and a multi-video package must not
 * silently pick a video for you.
 */

import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../fixtures/embedded_source.pkg.slp");

/** Run `fn` in the page with the fixture available as a `File`. */
async function inPage<T>(
  page: import("@playwright/test").Page,
  fn: (args: { file: File; mod: Record<string, unknown> }) => Promise<T>
): Promise<T> {
  await page.goto("/");
  await page.waitForSelector("text=SLEAP", { timeout: 30000 });
  const b64 = fs.readFileSync(FIXTURE).toString("base64");
  return page.evaluate(
    async ([b64, body]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bin], "embedded_source.pkg.slp");
      // Vite dev-server URL, resolved by the BROWSER at runtime — kept in a
      // variable so tsc doesn't try to resolve it as a build-time specifier.
      const modUrl = "/src/lib/hdf5VideoSource.ts";
      const mod = await import(modUrl);
      const run = new Function(`return (${body})`)() as (a: {
        file: File;
        mod: Record<string, unknown>;
      }) => Promise<unknown>;
      return run({ file, mod });
    },
    [b64, fn.toString()] as [string, string]
  ) as Promise<T>;
}

test("reads embedded frames by their SOURCE index, with the source extent", async ({
  page,
}) => {
  const result = await inPage<{
    shape: number[] | undefined;
    frameNumbers: number[] | undefined;
    at10: boolean;
    at30: boolean;
    at0: boolean;
    dataset: string | null | undefined;
  }>(page, async ({ file, mod }) => {
    const m = mod as {
      createHdf5BackendForFile: (f: File, h?: unknown) => Promise<{
        shape?: number[];
        frameNumbers?: number[];
        dataset?: string | null;
        getFrame: (i: number) => Promise<unknown>;
      }>;
    };
    // No stored dataset and no chooser: the lowest-indexed video is taken.
    const backend = await m.createHdf5BackendForFile(file);
    const at10 = (await backend.getFrame(10)) !== null;
    const at30 = (await backend.getFrame(30)) !== null;
    const at0 = (await backend.getFrame(0)) !== null;
    return {
      shape: backend.shape ? [...backend.shape] : undefined,
      frameNumbers: backend.frameNumbers ? [...backend.frameNumbers] : undefined,
      at10,
      at30,
      at0,
      dataset: backend.dataset,
    };
  });

  expect(result.dataset).toBe("video0/video");
  // Frame map read from the PACKAGE — not from the `.slp` that referenced it.
  expect(result.frameNumbers).toEqual([10, 20, 30]);
  // Seekbar spans the SOURCE video (the `frames` attr), not the 3 stored images.
  expect(result.shape).toEqual([100, 32, 32, 1]);
  expect(result.at10).toBe(true);
  expect(result.at30).toBe(true);
  // Frame 0 has no embedded image: legitimately absent, not a decode failure.
  expect(result.at0).toBe(false);
});

test("honours the stored dataset and the multi-video chooser", async ({
  page,
}) => {
  const result = await inPage<{
    stored: number[] | undefined;
    storedShape: number[] | undefined;
    picked: string;
  }>(page, async ({ file, mod }) => {
    const m = mod as {
      createHdf5BackendForFile: (
        f: File,
        h?: unknown
      ) => Promise<{
        frameNumbers?: number[];
        shape?: number[];
        dataset?: string | null;
        getFrame: (i: number) => Promise<unknown>;
      }>;
    };
    // The dataset the referencing `.slp` recorded wins over detection order.
    const stored = await m.createHdf5BackendForFile(file, {
      dataset: "video1/video",
    });
    // Deferred: the per-video metadata is read on the first frame, not at open.
    await stored.getFrame(0);
    // With several videos and nothing recorded, the chooser decides — and it
    // is handed every video in the package, in index order.
    let asked: string[] = [];
    const chosen = await m.createHdf5BackendForFile(file, {
      pickDataset: async (options: string[]) => {
        asked = options;
        return options[1];
      },
    });
    return {
      stored: stored.frameNumbers ? [...stored.frameNumbers] : undefined,
      storedShape: stored.shape ? [...stored.shape] : undefined,
      picked: `${chosen.dataset}|${asked.join(",")}`,
    };
  });
  expect(result.stored).toEqual([0]); // video1 embeds only frame 0
  expect(result.storedShape).toEqual([5, 32, 32, 1]); // its own source extent
  expect(result.picked).toBe("video1/video|video0/video,video1/video");
});

test("several videos in one package read their own datasets", async ({
  page,
}) => {
  // The shape of a real prediction file (labels_pr.test.0.slp): N Videos whose
  // source is ONE .pkg.slp, distinguished only by `dataset`. Each must read its
  // own frames — and from its own frame map, since the packages embed sparse
  // labeled frames of a much longer source.
  const result = await inPage<
    Array<{ dataset: string | null | undefined; frames: number[]; shape: number[] }>
  >(page, async ({ file, mod }) => {
    const m = mod as {
      createHdf5BackendForFile: (
        f: File,
        h?: unknown
      ) => Promise<{
        dataset?: string | null;
        frameNumbers?: number[];
        shape?: number[];
        getFrame: (i: number) => Promise<unknown>;
      }>;
    };
    const out = [];
    for (const dataset of ["video0/video", "video1/video"]) {
      const b = await m.createHdf5BackendForFile(file, { dataset });
      await b.getFrame(0); // triggers the deferred per-video metadata read
      out.push({
        dataset: b.dataset,
        frames: b.frameNumbers ? [...b.frameNumbers] : [],
        shape: b.shape ? [...b.shape] : [],
      });
    }
    return out;
  });

  expect(result[0]!.dataset).toBe("video0/video");
  expect(result[0]!.frames).toEqual([10, 20, 30]);
  expect(result[0]!.shape).toEqual([100, 32, 32, 1]);
  // A different dataset in the SAME file yields a different frame map + extent.
  expect(result[1]!.dataset).toBe("video1/video");
  expect(result[1]!.frames).toEqual([0]);
  expect(result[1]!.shape).toEqual([5, 32, 32, 1]);
});
