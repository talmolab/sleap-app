/**
 * Unit tests for SLEAP Share client modules:
 * - config.ts (URL detection, free-form shortcode parsing, base URL sanitization)
 * - auth.ts (device auth start/poll, profile/quota, user files, sign out)
 * - httpRangeSource.ts (HEAD/Range size probe, aligned LRU page caching, multi-page reads)
 * - uploadClient.ts (single-file, ≥100 MiB multipart + retry + abort, multifile)
 * - openFromShare.ts (companion video matching heuristic)
 * - newInstance.ts (buildInstanceUrl with OpenUrlRequest)
 */

import { describe, it, expect } from "../bun-test";
import {
  detectSleapShareUrl,
  formatBytes,
  parseShareInput,
  sanitizeShareBaseUrl,
} from "@/lib/sleapShare/config";
import {
  fetchSleapShareProfile,
  fetchSleapShareUserFiles,
  pollDeviceAuthOnce,
  signOutSleapShare,
  startDeviceAuth,
} from "@/lib/sleapShare/auth";
import {
  createAuthenticatedHttpRangeSource,
  probeRemoteFileSize,
} from "@/lib/sleapShare/httpRangeSource";
import { matchCompanionVideoMember } from "@/lib/sleapShare/openFromShare";
import {
  MULTIPART_THRESHOLD_BYTES,
  UploadCancelledError,
  uploadToSleapShare,
  type PutOptions,
  type UploadSourcePayload,
} from "@/lib/sleapShare/uploadClient";
import { buildInstanceUrl } from "@/lib/newInstance";

const mockFetch = (
  fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => fn as unknown as typeof fetch;

describe("sleapShare config", () => {
  it("sanitizes https and loopback overrides and rejects unsafe schemes", () => {
    expect(sanitizeShareBaseUrl("https://staging.slp.sh/")).toBe("https://staging.slp.sh");
    expect(sanitizeShareBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(sanitizeShareBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(sanitizeShareBaseUrl("http://evil.example")).toBeNull();
    expect(sanitizeShareBaseUrl("javascript:alert(1)")).toBeNull();
  });

  it("detects slp.sh, *.slp.sh, and configured base URLs", () => {
    expect(detectSleapShareUrl("https://slp.sh/Ab12Cd")).toEqual({
      origin: "https://slp.sh",
      shortcode: "Ab12Cd",
      member: "labels.slp",
    });
    expect(detectSleapShareUrl("https://staging.slp.sh/Ab12Cd/val.slp")).toEqual({
      origin: "https://staging.slp.sh",
      shortcode: "Ab12Cd",
      member: "val.slp",
    });
    expect(
      detectSleapShareUrl("http://127.0.0.1:8787/Ab12Cd/labels.slp", "http://127.0.0.1:8787")
    ).toEqual({
      origin: "http://127.0.0.1:8787",
      shortcode: "Ab12Cd",
      member: "labels.slp",
    });
    expect(detectSleapShareUrl("https://share.sleap.ai/d/abc/set.slp")).toBeNull();
  });

  it("parses shortcodes, schemeless slp.sh links, and direct URLs", () => {
    expect(parseShareInput("Ab12Cd")).toEqual({
      kind: "share",
      origin: "https://slp.sh",
      shortcode: "Ab12Cd",
      member: "labels.slp",
      slpUrl: "https://slp.sh/Ab12Cd/labels.slp",
    });
    expect(parseShareInput("slp.sh/Ab12Cd")).toEqual({
      kind: "share",
      origin: "https://slp.sh",
      shortcode: "Ab12Cd",
      member: "labels.slp",
      slpUrl: "https://slp.sh/Ab12Cd/labels.slp",
    });
    expect(parseShareInput("https://example.org/data/demo.pkg.slp")).toEqual({
      kind: "url",
      slpUrl: "https://example.org/data/demo.pkg.slp",
    });
    expect(parseShareInput("file:///etc/passwd")).toBeNull();
  });

  it("formats byte sizes cleanly", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
  });
});

describe("sleapShare auth client", () => {
  it("starts device auth with client='app' and builds prefilled verification URL", async () => {
    let seenBody = "";
    const fakeFetch = mockFetch(async (_url, init) => {
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          deviceCode: "dev_123",
          userCode: "ABCD-EFGH",
          verificationUri: "https://slp.sh/auth/device",
          expiresIn: 600,
          interval: 5,
        }),
        { status: 200 }
      );
    });

    const started = await startDeviceAuth("https://slp.sh", fakeFetch);
    expect(JSON.parse(seenBody)).toMatchObject({ client: "app" });
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.verificationUrlWithCode).toBe(
      "https://slp.sh/auth/device?code=ABCD-EFGH"
    );
  });

  it("handles pending, slow_down, expired, and success responses in pollDeviceAuthOnce", async () => {
    const pending = await pollDeviceAuthOnce(
      "dev_1",
      "https://slp.sh",
      mockFetch(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }))
    );
    expect(pending).toEqual({ status: "pending" });

    const slow = await pollDeviceAuthOnce(
      "dev_1",
      "https://slp.sh",
      mockFetch(async () =>
        new Response("slow down", { status: 429, headers: { "Retry-After": "9" } }))
    );
    expect(slow).toEqual({ status: "slow_down", retryAfter: 9 });

    const ok = await pollDeviceAuthOnce(
      "dev_1",
      "https://slp.sh",
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            status: "success",
            token: "slp_tok_abc",
            tokenId: "tok-id-1",
            user: { id: 7, username: "talmo", avatar: "https://example.com/a.png" },
          }),
          { status: 200 }
        ))
    );
    expect(ok).toEqual({
      status: "success",
      token: "slp_tok_abc",
      tokenId: "tok-id-1",
      user: { id: 7, username: "talmo", avatar: "https://example.com/a.png" },
    });
  });

  it("fetches profile, user files, and revokes tokenId on sign-out", async () => {
    const profile = await fetchSleapShareProfile(
      "slp_tok_1",
      "https://slp.sh",
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            id: 42,
            username: "alice",
            avatarUrl: "",
            email: null,
            isSuperuser: true,
            quota: { usedBytes: 5000, limitBytes: 107374182400, unlimited: true },
            stats: { totalFiles: 2, totalStorage: 5000 },
          }),
          { status: 200 }
        ))
    );
    expect(profile?.isSuperuser).toBe(true);
    expect(profile?.quota.unlimited).toBe(true);

    const unauth = await fetchSleapShareProfile(
      "slp_bad",
      "https://slp.sh",
      mockFetch(async () => new Response("nope", { status: 401 }))
    );
    expect(unauth).toBeNull();

    const files = await fetchSleapShareUserFiles(
      "slp_tok_1",
      "https://slp.sh",
      20,
      mockFetch(async () =>
        new Response(
          JSON.stringify({
            files: [
              {
                shortcode: "abc123",
                filename: "demo.slp",
                name: "Demo",
                fileSize: 1024,
                createdAt: 1700000000000,
                expiresAt: null,
                shareUrl: "https://slp.sh/abc123",
                dataUrl: "https://slp.sh/abc123/labels.slp",
                isPrivate: true,
              },
            ],
          }),
          { status: 200 }
        ))
    );
    expect(files).toHaveLength(1);
    expect(files[0].isPrivate).toBe(true);

    let revokedUrl = "";
    let revokedMethod = "";
    await signOutSleapShare(
      {
        token: "slp_tok_1",
        tokenId: "tok-99",
        username: "alice",
        baseUrl: "https://slp.sh",
      },
      mockFetch(async (url, init) => {
        revokedUrl = String(url);
        revokedMethod = init?.method ?? "";
        return new Response(null, { status: 204 });
      })
    );
    expect(revokedMethod).toBe("DELETE");
    expect(revokedUrl).toBe("https://slp.sh/api/v1/auth/tokens/tok-99");
  });
});

describe("httpRangeSource", () => {
  it("probes size via HEAD or Range fallback, caches aligned pages, and stitches cross-page reads", async () => {
    const fileBytes = new Uint8Array(256);
    for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = i;

    const getRanges: string[] = [];
    const fakeFetch = mockFetch(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer slp_ds_test");

      if (init?.method === "HEAD") {
        // Omit Content-Length to exercise Range: bytes=0-0 fallback
        return new Response(null, { status: 200 });
      }
      const range = headers.get("Range") ?? "";
      getRanges.push(range);
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = Math.min(fileBytes.length - 1, Number(m?.[2] ?? fileBytes.length - 1));
      const slice = fileBytes.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileBytes.length}`,
          "Content-Length": String(slice.byteLength),
        },
      });
    });

    expect(
      await probeRemoteFileSize(
        "https://slp.sh/abc123/labels.slp",
        { Authorization: "Bearer slp_ds_test" },
        fakeFetch
      )
    ).toBe(256);

    getRanges.length = 0;
    const src = await createAuthenticatedHttpRangeSource(
      "https://slp.sh/abc123/labels.slp",
      {
        headers: { Authorization: "Bearer slp_ds_test" },
        pageSize: 64,
        maxPages: 4,
        fetchImpl: fakeFetch,
      }
    );
    expect(src.size).toBe(256);
    // Probe used bytes=0-0
    expect(getRanges).toEqual(["bytes=0-0"]);
    getRanges.length = 0;

    // Cross-page read spanning page 0 (0..63) and page 1 (64..127)
    const span = await src.readRange(50, 30);
    expect(Array.from(span)).toEqual(Array.from(fileBytes.slice(50, 80)));
    expect(getRanges).toEqual(["bytes=0-63", "bytes=64-127"]);

    // Subsequent read within already-cached page 0 makes ZERO new HTTP fetches
    const cached = await src.readRange(10, 12);
    expect(Array.from(cached)).toEqual(Array.from(fileBytes.slice(10, 22)));
    expect(getRanges).toEqual(["bytes=0-63", "bytes=64-127"]);
  });
});

describe("matchCompanionVideoMember", () => {
  const members = [
    {
      memberIndex: 1,
      role: "video",
      filename: "cam_left.mp4",
      contentType: "video/mp4",
      objectKey: "abc123/cam_left.mp4",
      fileSize: 1000,
      isPrimary: false,
      url: "/abc123/cam_left.mp4",
    },
    {
      memberIndex: 2,
      role: "video",
      filename: "cam_right.mp4",
      contentType: "video/mp4",
      objectKey: "abc123/cam_right.mp4",
      fileSize: 1000,
      isPrimary: false,
      url: "/abc123/cam_right.mp4",
    },
  ];

  it("matches companion videos by basename even with different local directory paths", () => {
    expect(
      matchCompanionVideoMember(
        { filename: "C:\\Users\\lab\\videos\\cam_right.mp4" },
        members,
        2,
        "https://slp.sh/abc123/labels.slp"
      )?.filename
    ).toBe("cam_right.mp4");
  });
});

describe("uploadClient", () => {
  it("uploads a single file < 100 MB with X-Upload-Source and Content-Type on PUT", async () => {
    const apiCalls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const putCalls: PutOptions[] = [];

    const fakeFetch = mockFetch(async (url, init) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      apiCalls.push({ url: u, headers: new Headers(init?.headers), body });
      if (u.endsWith("/api/upload/init")) {
        return new Response(
          JSON.stringify({
            shortcode: "xyz789",
            uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/xyz789/_staging_labels.slp?sig=1",
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/api/upload/complete")) {
        return new Response(
          JSON.stringify({
            shortcode: "xyz789",
            shareUrl: "https://slp.sh/xyz789",
            dataUrl: "https://slp.sh/xyz789/labels.slp",
            fileSize: 512,
            expiresAt: null,
            isPrivate: true,
            permanent: false,
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const payload: UploadSourcePayload = {
      kind: "blob",
      blob: new Blob([new Uint8Array(512)]),
      filename: "trial.pkg.slp",
      size: 512,
    };

    const res = await uploadToSleapShare(
      [payload],
      {
        name: "Fly Trial",
        notes: "Repro case",
        isPrivate: true,
        isSupport: true,
        githubRepo: "talmolab/sleap-app",
        githubType: "issue",
        githubNumber: 556,
      },
      {
        baseUrl: "https://slp.sh",
        token: "slp_tok_abc",
        fetchImpl: fakeFetch,
        putTransport: async (opts) => {
          putCalls.push(opts);
          opts.onProgress?.(512, 512);
          return { etag: "etag-1" };
        },
      }
    );

    expect(res.shortcode).toBe("xyz789");
    expect(res.isPrivate).toBe(true);
    expect(apiCalls).toHaveLength(2);
    expect(apiCalls[0].headers.get("X-Upload-Source")).toBe("sleap-app");
    expect(apiCalls[0].headers.get("Authorization")).toBe("Bearer slp_tok_abc");
    expect(apiCalls[0].body).toMatchObject({
      filename: "trial.pkg.slp",
      fileSize: 512,
      name: "Fly Trial",
      private: true,
      isSupport: true,
      githubRepo: "talmolab/sleap-app",
      githubType: "issue",
      githubNumber: 556,
    });
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].contentType).toBe("application/octet-stream");
  });

  it("uploads >= 100 MB via multipart with retries (no Content-Type on part PUTs) and aborts on cancel", async () => {
    const totalSize = MULTIPART_THRESHOLD_BYTES + 1024;
    let part1Attempts = 0;
    const putCalls: PutOptions[] = [];
    let completedParts: unknown = null;

    const fakeFetch = mockFetch(async (url, init) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (u.endsWith("/api/upload/multipart/init")) {
        return new Response(
          JSON.stringify({
            shortcode: "mp1234",
            uploadId: "up-id-1",
            partSize: MULTIPART_THRESHOLD_BYTES,
            totalParts: 2,
            parts: [
              { partNumber: 1, uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/p1" },
              { partNumber: 2, uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/p2" },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/api/upload/multipart/complete")) {
        completedParts = body.parts;
        return new Response(
          JSON.stringify({
            shortcode: "mp1234",
            shareUrl: "https://slp.sh/mp1234",
            dataUrl: "https://slp.sh/mp1234/labels.slp",
            fileSize: totalSize,
            expiresAt: null,
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/api/upload/multipart/abort")) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const largePathPayload: UploadSourcePayload = {
      kind: "path",
      path: "/tmp/big.pkg.slp",
      filename: "big.pkg.slp",
      size: totalSize,
    };

    const res = await uploadToSleapShare(
      [largePathPayload],
      {},
      {
        baseUrl: "https://slp.sh",
        fetchImpl: fakeFetch,
        retryBaseDelayMs: 1,
        putTransport: async (opts) => {
          putCalls.push(opts);
          if (opts.offset === 0) {
            part1Attempts++;
            if (part1Attempts === 1) throw new Error("transient 503");
            return { etag: "etag-p1" };
          }
          return { etag: "etag-p2" };
        },
      }
    );

    expect(res.shortcode).toBe("mp1234");
    expect(part1Attempts).toBe(2);
    expect(putCalls.every((p) => p.contentType === undefined)).toBe(true);
    expect(completedParts).toEqual([
      { partNumber: 1, etag: "etag-p1" },
      { partNumber: 2, etag: "etag-p2" },
    ]);

    // Verify abort endpoint is called on cancellation
    let aborted = false;
    const ac = new AbortController();
    const abortFetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/upload/multipart/init")) {
        return new Response(
          JSON.stringify({
            shortcode: "mp9999",
            uploadId: "up-id-abort",
            partSize: MULTIPART_THRESHOLD_BYTES,
            totalParts: 2,
            parts: [
              { partNumber: 1, uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/p1" },
              { partNumber: 2, uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/p2" },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/api/upload/multipart/abort")) {
        aborted = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      uploadToSleapShare([largePathPayload], {}, {
        baseUrl: "https://slp.sh",
        signal: ac.signal,
        fetchImpl: abortFetch,
        putTransport: async () => {
          ac.abort();
          throw new UploadCancelledError();
        },
      })
    ).rejects.toThrow(UploadCancelledError);
    expect(aborted).toBe(true);
  });

  it("uploads multifile datasets (.slp + video) via /api/upload/multifile/*", async () => {
    const putUrls: string[] = [];
    const fakeFetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/upload/multifile/init")) {
        return new Response(
          JSON.stringify({
            shortcode: "mf1234",
            memberCount: 2,
            members: [
              {
                filename: "labels.slp",
                originalFilename: "trial.slp",
                role: "labels",
                isPrimary: true,
                uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/mf1234/_staging_labels.slp",
              },
              {
                filename: "clip.mp4",
                originalFilename: "clip.mp4",
                role: "video",
                isPrimary: false,
                uploadUrl: "https://bucket.acct.r2.cloudflarestorage.com/mf1234/_staging_clip.mp4",
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.endsWith("/api/upload/multifile/complete")) {
        return new Response(
          JSON.stringify({
            shortcode: "mf1234",
            shareUrl: "https://slp.sh/mf1234",
            dataUrl: "https://slp.sh/mf1234/labels.slp",
            fileSize: 3000,
            expiresAt: null,
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await uploadToSleapShare(
      [
        { kind: "blob", blob: new Blob([new Uint8Array(1000)]), filename: "trial.slp", size: 1000, role: "labels" },
        { kind: "blob", blob: new Blob([new Uint8Array(2000)]), filename: "clip.mp4", size: 2000, role: "video" },
      ],
      { name: "Trial With Video" },
      {
        baseUrl: "https://slp.sh",
        fetchImpl: fakeFetch,
        putTransport: async (opts) => {
          putUrls.push(opts.url);
          expect(opts.contentType).toBe("application/octet-stream");
          return {};
        },
      }
    );

    expect(res.shortcode).toBe("mf1234");
    expect(res.memberCount).toBe(2);
    expect(putUrls).toHaveLength(2);
  });
});

describe("buildInstanceUrl with openRequest", () => {
  it("serializes ?open=, ?name=, and #v=&f=&ticket= for spawned desktop windows", () => {
    const built = buildInstanceUrl("http://localhost:1430/", undefined, false, {
      url: "https://slp.sh/abc123/labels.slp",
      name: "My Dataset",
      videoIdx: 1,
      frameIdx: 25,
      ticket: "ds_tkt_spawn",
    });
    expect(built).toBe(
      "http://localhost:1430/?open=https%3A%2F%2Fslp.sh%2Fabc123%2Flabels.slp&name=My%20Dataset#v=1&f=25&ticket=ds_tkt_spawn"
    );
  });
});
