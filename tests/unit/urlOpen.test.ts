import { describe, it, expect } from "../bun-test";
import { readOpenParam, basenameFromUrl } from "@/lib/urlOpen";

describe("readOpenParam", () => {
  it("returns the decoded http(s) URL from ?open=", () => {
    const dl = "https://share.sleap.ai/d/abc/set.pkg.slp";
    expect(readOpenParam(`?open=${encodeURIComponent(dl)}`)).toBe(dl);
  });

  it("preserves a token query-suffix through the single encode/decode round-trip", () => {
    const dl = "https://share.sleap.ai/d/abc/set.pkg.slp?token=xyz123&exp=999";
    expect(readOpenParam(`?open=${encodeURIComponent(dl)}`)).toBe(dl);
  });

  it("coexists with other params", () => {
    const dl = "https://share.sleap.ai/set.slp";
    expect(readOpenParam(`?v=0&open=${encodeURIComponent(dl)}&f=3`)).toBe(dl);
  });

  it("rejects non-http(s) schemes", () => {
    expect(readOpenParam(`?open=${encodeURIComponent("file:///etc/passwd")}`)).toBeNull();
    expect(readOpenParam(`?open=${encodeURIComponent("gs://bucket/set.slp")}`)).toBeNull();
    expect(readOpenParam(`?open=${encodeURIComponent("s3://bucket/set.slp")}`)).toBeNull();
  });

  it("returns null for junk / relative / missing / empty", () => {
    expect(readOpenParam(`?open=not-a-url`)).toBeNull();
    expect(readOpenParam(`?open=/local/path.slp`)).toBeNull();
    expect(readOpenParam(`?open=`)).toBeNull();
    expect(readOpenParam(`?v=0&f=3`)).toBeNull();
    expect(readOpenParam(``)).toBeNull();
  });
});

describe("basenameFromUrl", () => {
  it("takes the last path segment, query stripped, decoded", () => {
    expect(basenameFromUrl("https://share.sleap.ai/d/abc/my%20set.pkg.slp?token=x"))
      .toBe("my set.pkg.slp");
  });
  it("falls back to hostname when there is no path segment", () => {
    expect(basenameFromUrl("https://share.sleap.ai/?token=x")).toBe("share.sleap.ai");
  });
  it("falls back to the raw string when not a URL", () => {
    expect(basenameFromUrl("garbage")).toBe("garbage");
  });
});
