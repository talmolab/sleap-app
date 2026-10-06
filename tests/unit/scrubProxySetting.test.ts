/**
 * Tests for the persisted `scrubProxyEnabled` UI preference (Local Scrub
 * Proxy v1, Task 7): default off, and toggled via `setScrubProxyEnabled`.
 */

import { describe, it, expect, beforeEach } from "../bun-test";
import { useAppStore, PERSISTED_KEYS } from "@/stores/appStore";

describe("scrubProxyEnabled setting", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("defaults to false", () => {
    expect(useAppStore.getState().scrubProxyEnabled).toBe(false);
  });

  it("is toggled by setScrubProxyEnabled", () => {
    useAppStore.getState().setScrubProxyEnabled(true);
    expect(useAppStore.getState().scrubProxyEnabled).toBe(true);

    useAppStore.getState().setScrubProxyEnabled(false);
    expect(useAppStore.getState().scrubProxyEnabled).toBe(false);
  });

  it("is included in the persisted keys so it survives a restart", () => {
    expect(PERSISTED_KEYS).toContain("scrubProxyEnabled");
  });
});
