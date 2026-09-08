/**
 * Tests for the Tauri invoke-key capture (src/lib/tauriInvokeKey.ts), which lets
 * the off-main decode worker call plugin:sleap|read_range directly.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  captureInvokeKey,
  getCachedInvokeKey,
  __resetInvokeKeyForTest,
} from "@/lib/tauriInvokeKey";

describe("captureInvokeKey", () => {
  beforeEach(() => __resetInvokeKeyForTest());

  it("captures the key set on a Headers during the triggered invoke", async () => {
    const key = await captureInvokeKey(async () => {
      new Headers().set("Tauri-Invoke-Key", "secret123");
    });
    expect(key).toBe("secret123");
    expect(getCachedInvokeKey()).toBe("secret123");
  });

  it("returns the cached key without re-running the trigger", async () => {
    await captureInvokeKey(async () => {
      new Headers().set("Tauri-Invoke-Key", "first");
    });
    let ran = false;
    const again = await captureInvokeKey(async () => {
      ran = true;
    });
    expect(again).toBe("first");
    expect(ran).toBe(false);
  });

  it("returns null when no invoke-key header is set", async () => {
    const key = await captureInvokeKey(async () => {
      new Headers().set("Content-Type", "application/json");
    });
    expect(key).toBeNull();
  });

  it("swallows a failing trigger and returns null (no throw)", async () => {
    const key = await captureInvokeKey(async () => {
      throw new Error("boom");
    });
    expect(key).toBeNull();
  });

  it("restores Headers.prototype.set after capturing", async () => {
    const before = Headers.prototype.set;
    await captureInvokeKey(async () => {
      new Headers().set("Tauri-Invoke-Key", "x");
    });
    expect(Headers.prototype.set).toBe(before);
  });
});
