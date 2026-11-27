/**
 * Component tests for the EnvironmentPanel's sleap-nn channel selector
 * (`Stable` vs `Pre-release`), version-derived Pre-release badges, target
 * preview before install, channel-switch downgrade action, and bundled
 * `sleap-io` version & update indicator.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { PyPiPackageVersions, SleapNnExtras, UvTool } from "@/platform/backend";

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.0-alpha.0" }));
vi.mock("@/lib/updateCheckCache", () => ({ checkUpdateCached: async () => null }));

const PYPI: PyPiPackageVersions = {
  sleapNn: ["0.3.5", "0.4.0a0"],
  sleapIo: ["0.9.6", "0.10.0a0"],
  error: null,
};

function makeTool(overrides: Partial<UvTool> = {}): UvTool {
  return {
    name: "sleap-nn",
    version: "0.4.0a0",
    commands: ["sleap-nn"],
    updateAvailable: false,
    latestVersion: "0.4.0a0",
    ...overrides,
  };
}

function makeExtras(overrides: Partial<SleapNnExtras> = {}): SleapNnExtras {
  return {
    onnx: false,
    tensorrt: false,
    backbones: false,
    pythonVersion: "3.12.7",
    sleapIoVersion: "0.10.0a0",
    tensorrtSupported: false,
    error: null,
    ...overrides,
  };
}

describe("EnvironmentPanel sleap-nn channel toggle, badges, and sleap-io row", () => {
  let switchCalls: number;
  let upgradeCalls: string[];

  beforeEach(async () => {
    switchCalls = 0;
    upgradeCalls = [];
    const { useEnvironmentStore } = await import("@/stores/environmentStore");
    act(() => {
      useEnvironmentStore.setState({
        uv: {
          available: true,
          version: "0.13.9",
          path: "/usr/local/bin/uv",
          pythonDir: null,
          updateAvailable: false,
          latestVersion: "0.13.9",
          selfUpdateSupported: true,
        },
        detectionStatus: "done",
        detectionError: null,
        tools: [],
        rawTools: [],
        interpreters: [],
        downloadable: [],
        sleapNnChannel: "prerelease",
        sleapNnChannelExplicitlySet: false,
        pypiVersions: PYPI,
        pypiVersionsStatus: "done",
        accelerator: null,
        acceleratorStatus: "idle",
        extras: null,
        extrasStatus: "idle",
        installStatus: "idle",
        installLog: [],
        installTarget: null,
        refresh: async () => {},
        doSwitchSleapNnChannel: async () => {
          switchCalls += 1;
        },
        doUpgradeTool: async (pkg: string) => {
          upgradeCalls.push(pkg);
        },
      });
    });
  });

  it("shows the target pre-release or stable version before sleap-nn is installed", async () => {
    const { EnvironmentPanel } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const { useEnvironmentStore } = await import("@/stores/environmentStore");

    const { baseElement } = render(<EnvironmentPanel />);
    expect(baseElement.textContent).toContain(
      "Will install v0.4.0a0 (pre-release) + sleap-io v0.10.0a0"
    );

    act(() => {
      useEnvironmentStore.getState().setSleapNnChannel("stable");
    });
    expect(baseElement.textContent).toContain("Will install v0.3.5 (stable)");
  });

  it("keeps the Pre-release badge on an installed alpha when switching the dropdown to Stable and offers Switch", async () => {
    const { EnvironmentPanel } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const { useEnvironmentStore } = await import("@/stores/environmentStore");

    const nn = makeTool();
    act(() => {
      useEnvironmentStore.setState({
        tools: [nn],
        rawTools: [nn],
        extras: makeExtras(),
        extrasStatus: "done",
      });
    });

    const { baseElement } = render(<EnvironmentPanel />);
    expect(baseElement.textContent).toContain("v0.4.0a0");
    expect(baseElement.textContent).toContain("v0.10.0a0");
    // Both sleap-nn and sleap-io show version-derived Pre-release badges
    expect(screen.getAllByText("Pre-release").length).toBeGreaterThanOrEqual(2);

    // Switch channel dropdown preference to Stable — installed version is still 0.4.0a0
    act(() => {
      useEnvironmentStore.getState().setSleapNnChannel("stable");
    });

    expect(baseElement.textContent).toContain("v0.4.0a0");
    expect(screen.getAllByText("Pre-release").length).toBeGreaterThanOrEqual(2);
    expect(baseElement.textContent).toContain("v0.3.5 (switch)");

    const switchBtn = screen.getByRole("button", { name: /^Switch$/i });
    fireEvent.click(switchBtn);
    expect(switchCalls).toBe(1);
  });

  it("surfaces a newer companion sleap-io release and unlocks the sleap-nn Update button", async () => {
    const { EnvironmentPanel } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const { useEnvironmentStore } = await import("@/stores/environmentStore");

    const nn = makeTool();
    act(() => {
      useEnvironmentStore.setState({
        tools: [nn],
        rawTools: [nn],
        extras: makeExtras({ sleapIoVersion: "0.10.0a0" }),
        extrasStatus: "done",
        pypiVersions: {
          sleapNn: ["0.3.5", "0.4.0a0"],
          sleapIo: ["0.9.6", "0.10.0a0", "0.10.0a1"],
          error: null,
        },
      });
    });

    const { baseElement } = render(<EnvironmentPanel />);
    expect(baseElement.textContent).toContain("v0.10.0a0");
    expect(baseElement.textContent).toContain("→ v0.10.0a1");

    const updateBtn = screen.getByTitle("Upgrade sleap-io to v0.10.0a1");
    expect(updateBtn).not.toBeDisabled();
    fireEvent.click(updateBtn);
    expect(upgradeCalls).toEqual(["sleap-nn"]);
  });
});
