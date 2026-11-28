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
let redeemedTickets = new Set<string>();
let uploadedInitPayload: Record<string, unknown> | null = null;
let uploadedSourceHeader: string | null = null;
let uploadedBytesLength = 0;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, X-Upload-Source",
  "Access-Control-Expose-Headers":
    "Content-Range, Content-Length, Accept-Ranges, ETag",
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

    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    // Mock single-file upload flow (/api/upload/init -> PUT /r2/... -> /api/upload/complete)
    if (req.method === "POST" && reqUrl.pathname === "/api/upload/init") {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        uploadedInitPayload = JSON.parse(body || "{}") as Record<string, unknown>;
        uploadedSourceHeader = String(req.headers["x-upload-source"] ?? "");
        res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            shortcode: "e2e999",
            uploadUrl: `${base}/r2/e2e999/_staging_labels.slp`,
            expiresAt: Date.now() + 3600_000,
            maxFileSize: 100 * 1024 * 1024,
            isPrivate: false,
          })
        );
      });
      return;
    }

    if (req.method === "PUT" && reqUrl.pathname === "/r2/e2e999/_staging_labels.slp") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        uploadedBytesLength = Buffer.concat(chunks).length;
        res.writeHead(200, { ...CORS, ETag: '"e2e-etag-1"' });
        res.end();
      });
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/upload/complete") {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            shortcode: "e2e999",
            shareUrl: `${base}/e2e999`,
            dataUrl: `${base}/e2e999/labels.slp`,
            fileSize: uploadedBytesLength,
            expiresAt: Date.now() + 7 * 86400_000,
            isPrivate: false,
            permanent: false,
          })
        );
      });
      return;
    }

    // Mock private handoff ticket redemption (single-use)
    if (req.method === "POST" && reqUrl.pathname === "/api/datasets/abc123/handoff/redeem") {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { ticket?: string };
        if (
          parsed.ticket === "ds_tkt_e2e_private" &&
          !redeemedTickets.has(parsed.ticket)
        ) {
          redeemedTickets.add(parsed.ticket);
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              token: "slp_ds_e2e_bearer",
              expiresAt: Date.now() + 3600_000,
            })
          );
          return;
        }
        res.writeHead(401, { ...CORS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired ticket" }));
      });
      return;
    }

    // Mock authenticated dataset metadata & members for private shortcode abc123
    if (reqUrl.pathname === "/api/metadata/abc123") {
      if (req.headers["authorization"] !== "Bearer slp_ds_e2e_bearer") {
        res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          shortcode: "abc123",
          originalFilename: "minimal_instance.slp",
          name: "Private Fly Trial",
          fileSize: bytes.length,
          uploadedAt: Date.now(),
          expiresAt: null,
          isPrivate: true,
          validationStatus: "valid",
        })
      );
      return;
    }

    if (reqUrl.pathname === "/api/datasets/abc123/members") {
      if (req.headers["authorization"] !== "Bearer slp_ds_e2e_bearer") {
        res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          shortcode: "abc123",
          memberCount: 1,
          kind: "single",
          members: [
            {
              memberIndex: 0,
              role: "labels",
              filename: "labels.slp",
              contentType: "application/octet-stream",
              objectKey: "abc123/labels.slp",
              fileSize: bytes.length,
              isPrimary: true,
              url: "/abc123/labels.slp",
            },
          ],
        })
      );
      return;
    }

    // Private dataset object requires the redeemed slp_ds_* bearer token
    if (reqUrl.pathname === "/abc123/labels.slp") {
      if (req.headers["authorization"] !== "Bearer slp_ds_e2e_bearer") {
        res.writeHead(404, CORS);
        res.end();
        return;
      }
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

test("redeems a private SLEAP Share #ticket=, strips credentials, preserves #v=&f=, and loads", async ({
  page,
}) => {
  redeemedTickets = new Set();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser:error] ${msg.text()}`);
  });
  page.on("requestfailed", (req) =>
    console.log(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`),
  );

  // Configure sleap-app to recognize the local mock server as its SLEAP Share host.
  await page.addInitScript((origin) => {
    window.localStorage.setItem("sleap-share:base-url", origin);
  }, base);

  const dl = `${base}/abc123/labels.slp`;
  await page.goto(
    `/?open=${encodeURIComponent(dl)}&name=${encodeURIComponent("Private Fly Trial")}#v=0&f=0&ticket=ds_tkt_e2e_private`,
  );

  await page.waitForSelector("text=SLEAP", { timeout: 15000 });
  await page.waitForSelector("text=Loaded Private Fly Trial", {
    timeout: 30000,
  });

  // ?open=, ?name=, and #ticket= are stripped while #v=0&f=0 view state stays intact.
  await expect
    .poll(() => {
      const u = new URL(page.url());
      return {
        hasOpen: u.searchParams.has("open"),
        hasName: u.searchParams.has("name"),
        hasTicket: u.hash.includes("ticket="),
        hash: u.hash,
      };
    })
    .toEqual({
      hasOpen: false,
      hasName: false,
      hasTicket: false,
      hash: "#v=0&f=0",
    });

  await expect(page.locator("canvas").first()).toBeVisible();
});

test("uploads an open project via File ▸ Upload to SLEAP Share… and displays the share link", async ({
  page,
}) => {
  uploadedInitPayload = null;
  uploadedSourceHeader = null;
  uploadedBytesLength = 0;

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser:error] ${msg.text()}`);
  });

  await page.addInitScript((origin) => {
    window.localStorage.setItem("sleap-share:base-url", origin);
  }, base);

  // Load a small fixture project first via ?open=
  const dl = `${base}/minimal_instance.slp`;
  await page.goto(`/?open=${encodeURIComponent(dl)}`);
  await page.waitForSelector("text=Loaded minimal_instance.slp", { timeout: 30000 });

  // Open File ▸ Upload to SLEAP Share...
  await page.getByRole("menuitem", { name: "File" }).click();
  await page.getByRole("menuitem", { name: "Upload to SLEAP Share..." }).click();

  await expect(
    page.getByRole("heading", { name: "Upload to SLEAP Share" }),
  ).toBeVisible();

  // Pick Labels only (.slp) (fixture has no continuous source video file on disk)
  await page.getByLabel("Labels only (.slp)").click();
  await page.getByLabel("Dataset name (optional)").fill("E2E Roundtrip");

  await page.getByRole("button", { name: "Upload to SLEAP Share" }).click();

  // Verify the success screen renders the returned share URL
  const resultInput = page.getByTestId("upload-share-result-url");
  await expect(resultInput).toHaveValue(`${base}/e2e999`, { timeout: 20000 });

  expect(uploadedSourceHeader).toBe("sleap-app");
  expect(uploadedInitPayload).toMatchObject({
    filename: "minimal_instance.slp",
    name: "E2E Roundtrip",
  });
  expect(uploadedBytesLength).toBeGreaterThan(1000);
});
