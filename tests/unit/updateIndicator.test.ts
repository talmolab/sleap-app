import { describe, it, expect } from "../bun-test";
import {
  computeEnvironmentUpdateStatus,
  type EnvironmentUpdateStatusInput,
} from "@/components/layout/UpdateIndicator";

/** Every signal off — the quiet baseline every test case overrides from. */
function baseInput(
  overrides: Partial<EnvironmentUpdateStatusInput> = {}
): EnvironmentUpdateStatusInput {
  return {
    isTauri: true,
    uvAvailable: true,
    sleapNnInstalled: true,
    sleapNnUpdateAvailable: false,
    packagesSetupNudgeDismissed: false,
    stableUpdateAvailable: false,
    stableUpdateVersion: null,
    latestUpdateAvailable: false,
    latestUpdateVersion: null,
    hasOptedIntoLatestChannel: false,
    ...overrides,
  };
}

describe("computeEnvironmentUpdateStatus", () => {
  it("is quiet when every signal is off (uv + sleap-nn both present)", () => {
    const s = computeEnvironmentUpdateStatus(baseInput());
    expect(s.available).toBe(false);
    expect(s.showSetupNudge).toBe(false);
    expect(s.title).toBeUndefined();
  });

  it("does not nudge before uv has been checked (uvAvailable === null)", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ uvAvailable: null, sleapNnInstalled: false })
    );
    expect(s.available).toBe(false);
    expect(s.showSetupNudge).toBe(false);
  });

  it("nudges when uv is missing", () => {
    const s = computeEnvironmentUpdateStatus(baseInput({ uvAvailable: false }));
    expect(s.available).toBe(true);
    expect(s.showSetupNudge).toBe(true);
    expect(s.label).toBe("Install packages");
    expect(s.title).toContain("uv isn't installed");
  });

  it("nudges when uv is present but sleap-nn isn't installed", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ sleapNnInstalled: false })
    );
    expect(s.available).toBe(true);
    expect(s.showSetupNudge).toBe(true);
    expect(s.title).toContain("sleap-nn isn't installed");
  });

  it("never nudges in the browser build, even with uv missing", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ isTauri: false, uvAvailable: false, sleapNnInstalled: false })
    );
    expect(s.available).toBe(false);
    expect(s.showSetupNudge).toBe(false);
  });

  it("a dismissed nudge stays permanently silent, even while still missing", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ uvAvailable: false, packagesSetupNudgeDismissed: true })
    );
    expect(s.available).toBe(false);
    expect(s.showSetupNudge).toBe(false);
  });

  it("the setup nudge outranks a pending stable update", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({
        uvAvailable: false,
        stableUpdateAvailable: true,
        stableUpdateVersion: "0.2.0",
      })
    );
    expect(s.showSetupNudge).toBe(true);
    expect(s.label).toBe("Install packages");
    expect(s.title).toContain("uv isn't installed");
  });

  it("falls back to the dismissed nudge's OWN update signal once dismissed", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({
        uvAvailable: false,
        packagesSetupNudgeDismissed: true,
        stableUpdateAvailable: true,
        stableUpdateVersion: "0.2.0",
      })
    );
    expect(s.showSetupNudge).toBe(false);
    expect(s.available).toBe(true);
    expect(s.label).toBe("Update available");
    expect(s.title).toBe("SLEAP v0.2.0 is available");
  });

  it("stable update available surfaces its version in the title", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ stableUpdateAvailable: true, stableUpdateVersion: "0.2.0" })
    );
    expect(s.available).toBe(true);
    expect(s.title).toBe("SLEAP v0.2.0 is available");
  });

  it("latest update only counts once hasOptedIntoLatestChannel is true", () => {
    const notOptedIn = computeEnvironmentUpdateStatus(
      baseInput({ latestUpdateAvailable: true, latestUpdateVersion: "0.2.0-1" })
    );
    expect(notOptedIn.available).toBe(false);

    const optedIn = computeEnvironmentUpdateStatus(
      baseInput({
        latestUpdateAvailable: true,
        latestUpdateVersion: "0.2.0-1",
        hasOptedIntoLatestChannel: true,
      })
    );
    expect(optedIn.available).toBe(true);
    expect(optedIn.title).toBe("SLEAP v0.2.0-1 is available (latest channel)");
  });

  it("stable takes priority over latest when both are available", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({
        stableUpdateAvailable: true,
        stableUpdateVersion: "0.2.0",
        latestUpdateAvailable: true,
        latestUpdateVersion: "0.2.0-1",
        hasOptedIntoLatestChannel: true,
      })
    );
    expect(s.title).toBe("SLEAP v0.2.0 is available");
  });

  it("sleap-nn update available surfaces when nothing else applies", () => {
    const s = computeEnvironmentUpdateStatus(
      baseInput({ sleapNnUpdateAvailable: true })
    );
    expect(s.available).toBe(true);
    expect(s.title).toBe("sleap-nn update available");
    expect(s.label).toBe("Update available");
  });
});
