import { describe, it, expect } from "../bun-test";
import { browserDeviceName, normalizeDeviceName, DEVICE_NAME_MAX } from "@/lib/protocolV1/deviceName";

describe("browserDeviceName", () => {
  const cases: Array<[string, string]> = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge on Windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    ["", "Browser"],
  ];
  for (const [ua, name] of cases) {
    it(`${name}`, () => expect(browserDeviceName(ua)).toBe(name));
  }
});

describe("normalizeDeviceName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeDeviceName("  Lab   Mac \n")).toBe("Lab Mac");
  });
  it("returns null for blank input", () => {
    expect(normalizeDeviceName("   ")).toBeNull();
    expect(normalizeDeviceName(null)).toBeNull();
  });
  it("caps the length", () => {
    expect(normalizeDeviceName("x".repeat(200))).toHaveLength(DEVICE_NAME_MAX);
  });
});
