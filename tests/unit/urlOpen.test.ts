import { describe, it, expect } from "../bun-test";
import {
  readOpenParam,
  readOpenRequest,
  stripOpenParamsFromUrl,
  parseSleapDeepLink,
  basenameFromUrl,
} from "@/lib/urlOpen";

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

describe("readOpenRequest & stripOpenParamsFromUrl", () => {
  it("parses ?open=, ?name=, and #v=&f=&ticket= from search + hash", () => {
    const dl = "https://slp.sh/abc123/labels.slp";
    const req = readOpenRequest(
      `?open=${encodeURIComponent(dl)}&name=${encodeURIComponent("Mouse Trial 1")}`,
      "#v=2&f=145&ticket=ds_tkt_secret999"
    );
    expect(req).toEqual({
      url: dl,
      name: "Mouse Trial 1",
      ticket: "ds_tkt_secret999",
      videoIdx: 2,
      frameIdx: 145,
    });
  });

  it("ignores negative or non-integer v/f values", () => {
    const req = readOpenRequest(
      `?open=${encodeURIComponent("https://slp.sh/abc123/labels.slp")}`,
      "#v=-1&f=3.5"
    );
    expect(req).toEqual({ url: "https://slp.sh/abc123/labels.slp" });
  });

  it("strips ?open=, ?name=, ?ticket=, and #ticket= while keeping path and #v=&f=", () => {
    const stripped = stripOpenParamsFromUrl(
      "https://app.sleap.ai/latest/?open=https%3A%2F%2Fslp.sh%2Fabc123%2Flabels.slp&name=Demo&foo=bar#v=1&f=42&ticket=ds_tkt_abc"
    );
    expect(stripped).toBe("https://app.sleap.ai/latest/?foo=bar#v=1&f=42");
  });

  it("clears hash completely when #ticket= was the only fragment param", () => {
    const stripped = stripOpenParamsFromUrl(
      "https://app.sleap.ai/latest/?open=https%3A%2F%2Fslp.sh%2Fabc123%2Flabels.slp#ticket=ds_tkt_only"
    );
    expect(stripped).toBe("https://app.sleap.ai/latest/");
  });
});

describe("parseSleapDeepLink", () => {
  it("parses sleap://open?url=... with name, v, f, and ticket", () => {
    const dl = "https://slp.sh/abc123/val.slp";
    const req = parseSleapDeepLink(
      `sleap://open?url=${encodeURIComponent(dl)}&name=Val+Split&v=0&f=12&ticket=ds_tkt_xyz`
    );
    expect(req).toEqual({
      url: dl,
      name: "Val Split",
      ticket: "ds_tkt_xyz",
      videoIdx: 0,
      frameIdx: 12,
    });
  });

  it("resolves sleap://open?share=<shortcode> against default share host", () => {
    expect(parseSleapDeepLink("sleap://open?share=Ab12Cd")).toEqual({
      url: "https://slp.sh/Ab12Cd/labels.slp",
    });
    expect(
      parseSleapDeepLink("sleap://open?share=Ab12Cd", "https://staging.slp.sh/")
    ).toEqual({
      url: "https://staging.slp.sh/Ab12Cd/labels.slp",
    });
  });

  it("rejects non-sleap schemes, unknown actions, and unsafe target URLs", () => {
    expect(parseSleapDeepLink("https://slp.sh/abc123")).toBeNull();
    expect(parseSleapDeepLink("sleap://delete?url=https://slp.sh/abc123/labels.slp")).toBeNull();
    expect(parseSleapDeepLink("sleap://open?url=file:///etc/passwd")).toBeNull();
    expect(parseSleapDeepLink("sleap://open?share=bad")).toBeNull();
    expect(parseSleapDeepLink("not-a-url")).toBeNull();
  });
});
