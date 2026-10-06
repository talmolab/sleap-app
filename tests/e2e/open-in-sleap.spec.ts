import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// Serve a fixture .slp the way a real sleap-share download URL must: CORS-open,
// CORP cross-origin (so it passes the app's COEP require-corp), range-capable,
// identity-encoded. A separate port ⇒ genuine cross-origin, exercising the remote
// streaming path (issue #217), not a same-origin shortcut.
// `import.meta.url` (not `__dirname`) because the suite runs as an ES module.
const FIXTURE = fileURLToPath(
  new URL("../fixtures/minimal_instance.slp", import.meta.url),
);
const bytes = fs.readFileSync(FIXTURE);

let server: http.Server;
let base = "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "Content-Range, Content-Length, Accept-Ranges",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Accept-Ranges": "bytes",
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const range = req.headers["range"];
    const headOnly = req.method === "HEAD";
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(String(range));
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : bytes.length - 1;
      const chunk = bytes.subarray(start, end + 1);
      res.writeHead(206, {
        ...CORS,
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Content-Length": String(chunk.length),
      });
      res.end(headOnly ? undefined : chunk);
      return;
    }
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    });
    res.end(headOnly ? undefined : bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("opens a remote .slp via ?open= and strips the token param", async ({
  page,
}) => {
  // Surface browser console + failed subresource fetches so a COEP/CORP/range
  // regression is diagnosable from CI logs rather than a bare timeout.
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser:error] ${msg.text()}`);
  });
  page.on("requestfailed", (req) =>
    console.log(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`),
  );

  const dl = `${base}/minimal_instance.slp`;
  await page.goto(`/?open=${encodeURIComponent(dl)}`);

  // App shell ready.
  await page.waitForSelector("text=SLEAP", { timeout: 15000 });

  // Remote streaming load succeeded: loadProjectFromUrl fires
  // toast.success(`Loaded ${basename}`). Match the basename explicitly — a bare
  // `text=Loaded` also matches the welcome screen's "No project loaded"
  // (Playwright text= is a case-insensitive substring), which would pass even if
  // the load never happened.
  await page.waitForSelector("text=Loaded minimal_instance.slp", {
    timeout: 30000,
  });

  // The token-bearing ?open= param is stripped from the address bar so it is
  // not bookmarked / re-fetched on reload (history.replaceState).
  await expect
    .poll(() => new URL(page.url()).searchParams.has("open"))
    .toBe(false);

  // The project rendered a viewer canvas.
  await expect(page.locator("canvas").first()).toBeVisible();
});
