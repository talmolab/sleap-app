/**
 * Tests for the startup WebCodecs feature-probe (src/lib/webcodecsProbe.ts).
 *
 * Standalone video decode in sleap-io.js (Mp4Box / MediaBunny backends) hard-
 * requires `window.VideoDecoder` (WebCodecs). On Linux desktop the Tauri
 * WebView is WebKitGTK, which commonly ships WebCodecs disabled/partial — so
 * MP4/WebM/MKV silently render as blank frames. The probe detects this at boot
 * and returns a platform-aware warning so we can surface it to the user.
 *
 * These tests cover the pure decision function only (no DOM).
 */

import { describe, it, expect } from "../bun-test";
import { probeWebCodecs } from "@/lib/webcodecsProbe";

const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

describe("probeWebCodecs", () => {
  it("reports supported with no warning when VideoDecoder exists", () => {
    const result = probeWebCodecs({
      hasVideoDecoder: true,
      isTauri: true,
      userAgent: LINUX_UA,
    });
    expect(result.supported).toBe(true);
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("flags Linux desktop (WebKitGTK) specifically when VideoDecoder is missing", () => {
    const result = probeWebCodecs({
      hasVideoDecoder: false,
      isTauri: true,
      userAgent: LINUX_UA,
    });
    expect(result.supported).toBe(false);
    expect(result.title).toBeTruthy();
    // Must name the actual culprit so the user (or a bug report) can act on it.
    expect(result.description).toContain("WebKitGTK");
    // And reassure that the embedded-image / .seq paths still work.
    expect(result.description?.toLowerCase()).toMatch(/embedded|\.seq/);
  });

  it("gives a generic browser message (not WebKitGTK) when missing in a browser", () => {
    const result = probeWebCodecs({
      hasVideoDecoder: false,
      isTauri: false,
      userAgent: CHROME_UA,
    });
    expect(result.supported).toBe(false);
    expect(result.title).toBeTruthy();
    expect(result.description).not.toContain("WebKitGTK");
    expect(result.description?.toLowerCase()).toContain("browser");
  });

  it("falls back to a generic message for non-Linux desktop (mac/windows WebView)", () => {
    const result = probeWebCodecs({
      hasVideoDecoder: false,
      isTauri: true,
      userAgent: MAC_UA,
    });
    expect(result.supported).toBe(false);
    expect(result.title).toBeTruthy();
    expect(result.description).not.toContain("WebKitGTK");
  });
});
