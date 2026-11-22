/**
 * The app installs sleap-nn below 0.4 only, until its train, predict and track
 * flows have been tried against 0.4. Every path that picks a sleap-nn version
 * carries the cap: first install, changing the export extras, reinstall and
 * the Update button. An update at or above the cap is not announced.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import {
  SLEAP_NN_VERSION_SPECIFIER,
  capSleapNnUpdate,
  isSleapNnVersionBelowCap,
  sleapNnInstallSpec,
} from "@/lib/sleapNnVersion";
import type { SleapNnExtras, UvTool } from "@/platform/backend";

type Event = { event: string; data: { line?: string; success?: boolean } };

const calls: string[] = [];
const toasts: string[] = [];
let gpu = "none";
let installedExtras: SleapNnExtras = {
  onnx: false,
  tensorrt: false,
  tensorrtSupported: true,
  error: null,
};
let listedTools: UvTool[] = [];

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@/lib/notify", () => ({
  toast: { info: (message: string) => toasts.push(message) },
}));
const unused = async () => {
  throw new Error("not used by this test");
};

vi.mock("@/platform/backend", () => ({
  detectUv: async () => ({
    available: true,
    version: "0.11.17",
    path: "/usr/bin/uv",
    pythonDir: null,
    updateAvailable: false,
    latestVersion: null,
    selfUpdateSupported: true,
  }),
  detectGpu: async () => gpu,
  detectAccelerator: async () => ({
    accelerator: "cpu",
    gpuCount: 0,
    gpus: [],
    torchVersion: null,
    cudaVersion: null,
    driverVersion: null,
    driverCompatible: null,
    driverMinRequired: null,
    os: "linux",
    error: null,
  }),
  detectSleapNnExtras: async () => installedExtras,
  listUvTools: async () => listedTools,
  listPythonInterpreters: async () => [],
  listDownloadablePythons: async () => [],
  checkPython: unused,
  installPython: unused,
  updateUv: unused,
  installUv: unused,
  uninstallUvTool: unused,
  upgradeUvTool: async (pkg: string, onEvent: (e: Event) => void) => {
    calls.push(`upgrade ${pkg}`);
    onEvent({ event: "finished", data: { success: true } });
  },
  installUvTool: async (
    pkg: string,
    python: string | null,
    force: boolean,
    onEvent: (e: Event) => void,
    extraArgs?: string[]
  ) => {
    calls.push(
      [
        `install ${pkg}`,
        python ? `--python ${python}` : null,
        force ? "--force" : null,
        ...(extraArgs ?? []),
      ]
        .filter(Boolean)
        .join(" ")
    );
    onEvent({ event: "finished", data: { success: true } });
  },
}));

let realRefresh: (() => Promise<void>) | null = null;

async function store() {
  const { useEnvironmentStore } = await import("@/stores/environmentStore");
  realRefresh ??= useEnvironmentStore.getState().refresh;
  useEnvironmentStore.setState({
    refresh: async () => {},
    tools: listedTools,
    extras: null,
    selectedPythonPath: null,
    lastNotifiedSleapNnVersion: null,
  });
  return useEnvironmentStore;
}

function tool(overrides: Partial<UvTool> = {}): UvTool {
  return {
    name: "sleap-nn",
    version: "0.3.5",
    commands: ["sleap-nn"],
    updateAvailable: true,
    latestVersion: "0.4.0",
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  gpu = "none";
  installedExtras = {
    onnx: false,
    tensorrt: false,
    tensorrtSupported: true,
    error: null,
  };
  listedTools = [];
});

describe("sleapNnInstallSpec", () => {
  it("caps sleap-nn below 0.4", () => {
    expect(SLEAP_NN_VERSION_SPECIFIER).toBe("<0.4");
    expect(sleapNnInstallSpec(["torch-cpu"])).toBe("sleap-nn[torch-cpu]<0.4");
    expect(sleapNnInstallSpec(["torch-cuda130", "export", "tensorrt"])).toBe(
      "sleap-nn[torch-cuda130,export,tensorrt]<0.4"
    );
    expect(sleapNnInstallSpec([])).toBe("sleap-nn<0.4");
  });
});

describe("isSleapNnVersionBelowCap", () => {
  it("accepts every 0.3 and older release", () => {
    for (const v of ["0.0.1", "0.1.1", "0.3.0", "0.3.5", "0.3.99", "v0.3.5"]) {
      expect(isSleapNnVersionBelowCap(v)).toBe(true);
    }
  });

  it("rejects 0.4 and newer, pre-releases included", () => {
    for (const v of ["0.4", "0.4.0", "0.4.0rc1", "0.4.1", "0.10.0", "1.0.0"]) {
      expect(isSleapNnVersionBelowCap(v)).toBe(false);
    }
  });
});

describe("capSleapNnUpdate", () => {
  it("hides an update at or above the cap", () => {
    expect(capSleapNnUpdate(tool({ latestVersion: "0.4.0" }))).toEqual(
      tool({ updateAvailable: null, latestVersion: null })
    );
  });

  it("keeps an update below the cap", () => {
    const t = tool({ latestVersion: "0.3.6" });
    expect(capSleapNnUpdate(t)).toBe(t);
  });

  it("leaves an up-to-date or unchecked tool alone", () => {
    // For an up-to-date tool the backend reports the installed version as
    // the latest.
    const upToDate = tool({ updateAvailable: false, latestVersion: "0.3.5" });
    expect(capSleapNnUpdate(upToDate)).toBe(upToDate);
    const unknown = tool({ updateAvailable: null, latestVersion: null });
    expect(capSleapNnUpdate(unknown)).toBe(unknown);
  });

  // A sleap-nn already at 0.4 must keep reading as up to date. Turning it
  // into "unknown" would offer an Update that could only move it down.
  it("leaves an up-to-date sleap-nn at or above the cap alone", () => {
    const above = tool({
      version: "0.4.0",
      updateAvailable: false,
      latestVersion: "0.4.0",
    });
    expect(capSleapNnUpdate(above)).toBe(above);
  });

  it("leaves other tools alone", () => {
    const other = tool({ name: "sleap-connect", latestVersion: "0.4.0" });
    expect(capSleapNnUpdate(other)).toBe(other);
  });
});

describe("every sleap-nn install the app runs is capped", () => {
  it("first install, CPU", async () => {
    const s = await store();
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu]<0.4 --torch-backend=auto",
    ]);
  });

  it("first install, CUDA, with a selected Python", async () => {
    gpu = "cuda";
    const s = await store();
    s.setState({ selectedPythonPath: "/opt/py/bin/python3" });
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cuda130]<0.4 --python /opt/py/bin/python3 --torch-backend=auto",
    ]);
  });

  it("changing the export extras", async () => {
    gpu = "cuda";
    const s = await store();
    await s.getState().installExtras({ onnx: true, tensorrt: true });
    expect(calls).toEqual([
      "install sleap-nn[torch-cuda130,export,tensorrt]<0.4 --force --torch-backend=auto",
    ]);
  });

  it("removing the export extras", async () => {
    const s = await store();
    await s.getState().installExtras({ onnx: false, tensorrt: false });
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu]<0.4 --force --torch-backend=auto",
    ]);
  });

  it("reinstall", async () => {
    const s = await store();
    await s.getState().doReinstallTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu]<0.4 --force --torch-backend=auto",
    ]);
  });

  it("leaves other tools uncapped", async () => {
    const s = await store();
    await s.getState().doInstallTool("sleap-connect");
    await s.getState().doUpgradeTool("sleap-connect");
    expect(calls).toEqual(["install sleap-connect", "upgrade sleap-connect"]);
  });
});

describe("the Update button for sleap-nn", () => {
  // `uv tool upgrade` follows the range recorded at install time; installs
  // made before the cap recorded none and would move to 0.4.
  it("runs a capped install with --upgrade, not `uv tool upgrade`", async () => {
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu]<0.4 --upgrade --torch-backend=auto",
    ]);
    expect(s.getState().installStatus).toBe("done");
  });

  it("keeps the interpreter the env already has", async () => {
    const s = await store();
    s.setState({ selectedPythonPath: "/opt/py/bin/python3" });
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls[0]).not.toContain("--python");
  });

  it("restates the extras the env has now", async () => {
    gpu = "cuda";
    installedExtras = { ...installedExtras, onnx: true, tensorrt: true };
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cuda130,export,tensorrt]<0.4 --upgrade --torch-backend=auto",
    ]);
  });

  it("stops, and installs nothing, when the extras can't be read", async () => {
    installedExtras = { ...installedExtras, error: "python exited" };
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([]);
    expect(s.getState().installStatus).toBe("error");
    // Reinstall drops the export extras, and the message says so.
    expect(s.getState().installLog.join("\n")).toContain(
      "without the ONNX and TensorRT extras"
    );
  });

  it("falls back to the last good reading of the extras", async () => {
    installedExtras = { ...installedExtras, error: "python exited" };
    const s = await store();
    s.setState({
      extras: { onnx: true, tensorrt: false, tensorrtSupported: true, error: null },
    });
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu,export]<0.4 --upgrade --torch-backend=auto",
    ]);
  });

  // The capped install would move the env down, to the newest 0.3.
  it("never downgrades a sleap-nn that is already at or above the cap", async () => {
    listedTools = [
      tool({ version: "0.4.0", updateAvailable: false, latestVersion: "0.4.0" }),
    ];
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([]);
    expect(s.getState().installStatus).toBe("error");
    expect(s.getState().installLog.join("\n")).toContain("nothing to update to");
  });

  it("says that extras added outside the app are not kept", async () => {
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(s.getState().installLog.join("\n")).toContain(
      "Extras or install options added outside the app are not kept."
    );
  });
});

describe("the Environment panel's refresh", () => {
  // The tests above replace refresh(); this one runs the real one, which
  // feeds the panel's tool rows.
  it("hides an update at or above the cap", async () => {
    listedTools = [
      tool({ latestVersion: "0.4.0" }),
      tool({ name: "sleap-connect", version: "0.0.8", latestVersion: "0.4.0" }),
    ];
    const s = await store();
    await realRefresh!();
    const [nn, connect] = s.getState().tools;
    expect(nn.updateAvailable).toBeNull();
    expect(nn.latestVersion).toBeNull();
    expect(connect.updateAvailable).toBe(true);
    expect(connect.latestVersion).toBe("0.4.0");
  });

  it("keeps an update below the cap", async () => {
    listedTools = [tool({ latestVersion: "0.3.6" })];
    const s = await store();
    await realRefresh!();
    expect(s.getState().tools[0].updateAvailable).toBe(true);
    expect(s.getState().tools[0].latestVersion).toBe("0.3.6");
  });
});

describe("the update check", () => {
  it("does not announce a release at or above the cap", async () => {
    listedTools = [tool({ latestVersion: "0.4.0" })];
    const s = await store();
    await s.getState().checkSleapNnUpdateAndNotify();
    expect(toasts).toEqual([]);
    expect(s.getState().tools[0].updateAvailable).toBeNull();
    expect(s.getState().tools[0].latestVersion).toBeNull();
    expect(s.getState().lastNotifiedSleapNnVersion).toBeNull();
  });

  it("still announces a release below the cap", async () => {
    listedTools = [tool({ latestVersion: "0.3.6" })];
    const s = await store();
    await s.getState().checkSleapNnUpdateAndNotify();
    expect(toasts).toEqual(["sleap-nn v0.3.6 is available"]);
    expect(s.getState().tools[0].latestVersion).toBe("0.3.6");
  });
});
