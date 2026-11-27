/**
 * The app targets sleap-nn 0.4 (`>=0.4.0a0,<0.5`) alongside bare
 * `--with sleap-io>=0.10.0a0,<0.11.0`, enforces Python `>=3.11,<3.14`,
 * unlocks the Update button for existing 0.3.x installs, preserves the
 * `backbones` extra across update/reinstall/toggle, and hides 0.5+ updates.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import {
  SLEAP_IO_WITH_SPEC,
  SLEAP_NN_PYTHON_SPEC,
  SLEAP_NN_STABLE_SPECIFIER,
  SLEAP_NN_VERSION_CAP,
  SLEAP_NN_VERSION_FLOOR,
  SLEAP_NN_VERSION_SPECIFIER,
  capSleapNnUpdate,
  comparePep440Versions,
  exportExtras,
  installedSleapNnVersion,
  isPep440Prerelease,
  isPythonVersionCompatible,
  isSleapNnVersionBelowCap,
  isSleapNnVersionBelowFloor,
  parseSleapNnVersion,
  pickLatestSleapIoVersion,
  pickLatestSleapNnVersion,
  reconcileSleapNnTool,
  resolveSleapNnStatus,
  sleapNnInstallSpec,
  sleapNnSupportsSlp3,
  sleapNnUvExtraArgs,
} from "@/lib/sleapNnVersion";
import type {
  PyPiPackageVersions,
  PythonInterpreter,
  SleapNnExtras,
  UvTool,
} from "@/platform/backend";

type Event = { event: string; data: { line?: string; success?: boolean } };

const calls: string[] = [];
const toasts: string[] = [];
let gpu = "none";
let installedExtras: SleapNnExtras = {
  onnx: false,
  tensorrt: false,
  backbones: false,
  pythonVersion: "3.12.7",
  sleapIoVersion: "0.10.0a0",
  tensorrtSupported: true,
  error: null,
};
let listedTools: UvTool[] = [];
let listedInterpreters: PythonInterpreter[] = [];
let mockPypiVersions: PyPiPackageVersions | null = null;

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
  checkSleapNnVersions: async () =>
    mockPypiVersions ?? { sleapNn: [], sleapIo: [], error: null },
  listUvTools: async () => listedTools,
  listPythonInterpreters: async () => listedInterpreters,
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
    rawTools: listedTools,
    sleapNnChannel: "prerelease",
    sleapNnChannelExplicitlySet: false,
    pypiVersions: mockPypiVersions,
    interpreters: listedInterpreters,
    extras: null,
    selectedPythonPath: null,
    pythonCheck: null,
    lastNotifiedSleapNnVersion: null,
  });
  return useEnvironmentStore;
}

function tool(overrides: Partial<UvTool> = {}): UvTool {
  return {
    name: "sleap-nn",
    version: "0.4.0a0",
    commands: ["sleap-nn"],
    updateAvailable: true,
    latestVersion: "0.5.0",
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
    backbones: false,
    pythonVersion: "3.12.7",
    sleapIoVersion: "0.10.0a0",
    tensorrtSupported: true,
    error: null,
  };
  listedTools = [];
  listedInterpreters = [];
  mockPypiVersions = null;
});

describe("sleapNnInstallSpec & sleapNnUvExtraArgs", () => {
  it("targets >=0.4.0a0,<0.5 and includes bare sleap-io>=0.10.0a0,<0.11.0 (never [pyav])", () => {
    expect(SLEAP_NN_VERSION_FLOOR).toBe("0.4.0a0");
    expect(SLEAP_NN_VERSION_CAP).toBe("0.5");
    expect(SLEAP_NN_VERSION_SPECIFIER).toBe(">=0.4.0a0,<0.5");
    expect(SLEAP_IO_WITH_SPEC).toBe("sleap-io>=0.10.0a0,<0.11.0");
    expect(SLEAP_IO_WITH_SPEC).not.toContain("pyav");
    expect(sleapNnInstallSpec(["torch-cpu"])).toBe(
      "sleap-nn[torch-cpu]>=0.4.0a0,<0.5"
    );
    expect(
      sleapNnInstallSpec(["torch-cuda130", "export", "tensorrt", "backbones"])
    ).toBe("sleap-nn[torch-cuda130,export,tensorrt,backbones]>=0.4.0a0,<0.5");
    expect(sleapNnInstallSpec([])).toBe("sleap-nn>=0.4.0a0,<0.5");
    expect(sleapNnUvExtraArgs(["--upgrade"])).toEqual([
      "--upgrade",
      "--torch-backend=auto",
      "--with",
      "sleap-io>=0.10.0a0,<0.11.0",
    ]);
  });

  it("includes backbones in exportExtras when installed", () => {
    expect(exportExtras({ onnx: false, tensorrt: false, backbones: true })).toEqual([
      "backbones",
    ]);
    expect(exportExtras({ onnx: true, tensorrt: true, backbones: true })).toEqual([
      "export",
      "tensorrt",
      "backbones",
    ]);
  });
});

describe("PEP 440 version parsing, ordering, Python range & SLP 3.0 gating", () => {
  it("parses and orders PEP 440 pre-releases, finals, and post releases", () => {
    expect(parseSleapNnVersion("0.4.0a0")).not.toBeNull();
    expect(parseSleapNnVersion("not-a-version")).toBeNull();
    expect(comparePep440Versions("0.3.5", "0.4.0a0")).toBe(-1);
    expect(comparePep440Versions("0.4.0.dev0", "0.4.0a0")).toBe(-1);
    expect(comparePep440Versions("0.4.0a0", "0.4.0a1")).toBe(-1);
    expect(comparePep440Versions("0.4.0a1", "0.4.0b0")).toBe(-1);
    expect(comparePep440Versions("0.4.0b0", "0.4.0rc1")).toBe(-1);
    expect(comparePep440Versions("0.4.0rc1", "0.4.0")).toBe(-1);
    expect(comparePep440Versions("0.4.0", "0.4.0.post1")).toBe(-1);
    expect(comparePep440Versions("0.4.0a0", "0.3.4")).toBe(1);
    expect(comparePep440Versions("0.3.0a1", "0.3.2")).toBe(-1);
    expect(comparePep440Versions("v0.4.0a0", "0.4.0a0")).toBe(0);
  });

  it("gates native SLP 3.0 on >= 0.4.0a0 and stays conservative when unknown", () => {
    expect(sleapNnSupportsSlp3("0.4.0a0")).toBe(true);
    expect(sleapNnSupportsSlp3("0.4.0a1")).toBe(true);
    expect(sleapNnSupportsSlp3("0.4.0")).toBe(true);
    expect(sleapNnSupportsSlp3("0.3.5")).toBe(false);
    expect(sleapNnSupportsSlp3(null)).toBe(false);
    expect(sleapNnSupportsSlp3(undefined)).toBe(false);
  });

  it("accepts Python 3.11–3.13 and rejects 3.10 and 3.14+", () => {
    expect(isPythonVersionCompatible("3.11.0")).toBe(true);
    expect(isPythonVersionCompatible("3.12.7")).toBe(true);
    expect(isPythonVersionCompatible("3.13.11")).toBe(true);
    expect(isPythonVersionCompatible("3.10.14")).toBe(false);
    expect(isPythonVersionCompatible("3.9.6")).toBe(false);
    expect(isPythonVersionCompatible("3.14.0")).toBe(false);
    expect(isPythonVersionCompatible(null)).toBe(false);
  });

  it("resolves installed sleap-nn version from uv tools first, then pythonCheck", () => {
    expect(
      installedSleapNnVersion({
        tools: [tool({ version: "0.4.0a0" })],
        pythonCheck: { sleapNnVersion: "0.3.5" },
      })
    ).toBe("0.4.0a0");
    expect(
      installedSleapNnVersion({
        tools: [],
        pythonCheck: { sleapNnVersion: "0.3.5" },
      })
    ).toBe("0.3.5");
  });
});

describe("isSleapNnVersionBelowCap & isSleapNnVersionBelowFloor", () => {
  it("accepts every 0.4 and older release below 0.5", () => {
    for (const v of ["0.3.5", "0.4.0a0", "0.4.0a1", "0.4.0rc1", "0.4.0", "0.4.9", "v0.4.0"]) {
      expect(isSleapNnVersionBelowCap(v)).toBe(true);
    }
  });

  it("rejects 0.5 and newer, pre-releases included", () => {
    for (const v of ["0.5", "0.5.0", "0.5.0a0", "0.5.0rc1", "0.10.0", "1.0.0"]) {
      expect(isSleapNnVersionBelowCap(v)).toBe(false);
    }
  });

  it("flags < 0.4.0a0 as below floor", () => {
    expect(isSleapNnVersionBelowFloor("0.3.5")).toBe(true);
    expect(isSleapNnVersionBelowFloor("0.4.0a0")).toBe(false);
    expect(isSleapNnVersionBelowFloor("0.4.0")).toBe(false);
  });
});

describe("capSleapNnUpdate", () => {
  it("forces updateAvailable=true for 0.3.5 even when uv tool list --outdated ignores pre-releases", () => {
    const stuck = tool({
      version: "0.3.5",
      updateAvailable: false,
      latestVersion: "0.3.5",
    });
    expect(capSleapNnUpdate(stuck)).toEqual({
      ...stuck,
      updateAvailable: true,
      latestVersion: "0.4.0a0",
    });
  });

  it("keeps an in-range 0.4.x update reported for 0.3.5", () => {
    const t = tool({
      version: "0.3.5",
      updateAvailable: true,
      latestVersion: "0.4.0",
    });
    expect(capSleapNnUpdate(t)).toBe(t);
  });

  it("hides an update at or above the 0.5 cap for a 0.4.x install", () => {
    expect(capSleapNnUpdate(tool({ latestVersion: "0.5.0" }))).toEqual(
      tool({ updateAvailable: null, latestVersion: null })
    );
    expect(capSleapNnUpdate(tool({ latestVersion: "0.5.0a0" }))).toEqual(
      tool({ updateAvailable: null, latestVersion: null })
    );
  });

  it("keeps an update within 0.4 (e.g. 0.4.0a0 -> 0.4.0a1 or 0.4.0)", () => {
    const t1 = tool({ version: "0.4.0a0", latestVersion: "0.4.0a1" });
    expect(capSleapNnUpdate(t1)).toBe(t1);
    const t2 = tool({ version: "0.4.0a0", latestVersion: "0.4.0" });
    expect(capSleapNnUpdate(t2)).toBe(t2);
  });

  it("leaves an up-to-date or unchecked 0.4+ tool alone", () => {
    const upToDate = tool({ version: "0.4.0a0", updateAvailable: false, latestVersion: "0.4.0a0" });
    expect(capSleapNnUpdate(upToDate)).toBe(upToDate);
    const unknown = tool({ version: "0.4.0a0", updateAvailable: null, latestVersion: null });
    expect(capSleapNnUpdate(unknown)).toBe(unknown);
  });

  it("leaves an up-to-date sleap-nn at or above the cap alone", () => {
    const above = tool({
      version: "0.5.0",
      updateAvailable: false,
      latestVersion: "0.5.0",
    });
    expect(capSleapNnUpdate(above)).toBe(above);
  });

  it("leaves other tools alone", () => {
    const other = tool({ name: "sleap-connect", latestVersion: "0.5.0" });
    expect(capSleapNnUpdate(other)).toBe(other);
  });
});

describe("every sleap-nn install passes >=0.4.0a0,<0.5, --with sleap-io>=0.10.0a0,<0.11.0, and Python >=3.11,<3.14", () => {
  it("first install, CPU", async () => {
    const s = await store();
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("first install, CUDA, with a compatible selected Python", async () => {
    gpu = "cuda";
    listedInterpreters = [
      { key: "cpython-3.12", version: "3.12.7", path: "/opt/py/bin/python3", source: "system" },
    ];
    const s = await store();
    s.setState({ selectedPythonPath: "/opt/py/bin/python3" });
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cuda130]>=0.4.0a0,<0.5 --python /opt/py/bin/python3 --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0",
    ]);
  });

  it("overrides an incompatible selected Python (3.10 or 3.14) with >=3.11,<3.14", async () => {
    listedInterpreters = [
      { key: "cpython-3.10", version: "3.10.14", path: "/opt/py310/bin/python3", source: "system" },
    ];
    const s = await store();
    s.setState({ selectedPythonPath: "/opt/py310/bin/python3" });
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("changing export + backbones extras", async () => {
    gpu = "cuda";
    const s = await store();
    await s.getState().installExtras({ onnx: true, tensorrt: true, backbones: true });
    expect(calls).toEqual([
      `install sleap-nn[torch-cuda130,export,tensorrt,backbones]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("installExportExtra preserves already-installed backbones extra", async () => {
    const s = await store();
    s.setState({
      extras: {
        onnx: false,
        tensorrt: false,
        backbones: true,
        pythonVersion: "3.12.7",
        tensorrtSupported: true,
        error: null,
      },
    });
    await s.getState().installExportExtra(false);
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu,export,backbones]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("removing all optional extras", async () => {
    const s = await store();
    await s.getState().installExtras({ onnx: false, tensorrt: false, backbones: false });
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("reinstall preserves installed backbones & export extras", async () => {
    installedExtras = { ...installedExtras, backbones: true };
    const s = await store();
    await s.getState().doReinstallTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu,backbones]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("reinstall still succeeds without extras when extras probe fails", async () => {
    installedExtras = { ...installedExtras, error: "broken venv" };
    const s = await store();
    await s.getState().doReinstallTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
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
  it("runs a bounded install with --upgrade and --with sleap-io>=0.10.0a0,<0.11.0", async () => {
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --upgrade --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0",
    ]);
    expect(s.getState().installStatus).toBe("done");
  });

  it("keeps a compatible interpreter the env already has", async () => {
    const s = await store();
    s.setState({ selectedPythonPath: "/opt/py/bin/python3" });
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls[0]).not.toContain("--python");
  });

  it("switches to >=3.11,<3.14 when upgrading an old Python 3.10 venv", async () => {
    installedExtras = { ...installedExtras, pythonVersion: "3.10.14" };
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]>=0.4.0a0,<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --upgrade --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0`,
    ]);
  });

  it("restates onnx, tensorrt, and backbones extras on update", async () => {
    gpu = "cuda";
    installedExtras = { ...installedExtras, onnx: true, tensorrt: true, backbones: true };
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cuda130,export,tensorrt,backbones]>=0.4.0a0,<0.5 --upgrade --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0",
    ]);
  });

  it("stops, and installs nothing, when the extras can't be read", async () => {
    installedExtras = { ...installedExtras, error: "python exited" };
    const s = await store();
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([]);
    expect(s.getState().installStatus).toBe("error");
    expect(s.getState().installLog.join("\n")).toContain(
      "without optional extras"
    );
  });

  it("falls back to the last good reading of the extras", async () => {
    installedExtras = { ...installedExtras, error: "python exited" };
    const s = await store();
    s.setState({
      extras: {
        onnx: true,
        tensorrt: false,
        backbones: true,
        pythonVersion: "3.12.7",
        tensorrtSupported: true,
        error: null,
      },
    });
    await s.getState().doUpgradeTool("sleap-nn");
    expect(calls).toEqual([
      "install sleap-nn[torch-cpu,export,backbones]>=0.4.0a0,<0.5 --upgrade --torch-backend=auto --with sleap-io>=0.10.0a0,<0.11.0",
    ]);
  });

  it("never downgrades a sleap-nn that is already at or above the 0.5 cap", async () => {
    listedTools = [
      tool({ version: "0.5.0", updateAvailable: false, latestVersion: "0.5.0" }),
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
  it("hides an update at or above the 0.5 cap", async () => {
    listedTools = [
      tool({ version: "0.4.0a0", latestVersion: "0.5.0" }),
      tool({ name: "sleap-connect", version: "0.0.8", latestVersion: "0.5.0" }),
    ];
    const s = await store();
    await realRefresh!();
    const [nn, connect] = s.getState().tools;
    expect(nn.updateAvailable).toBeNull();
    expect(nn.latestVersion).toBeNull();
    expect(connect.updateAvailable).toBe(true);
    expect(connect.latestVersion).toBe("0.5.0");
  });

  it("keeps an update within 0.4 and flags 0.3.5 as upgradable to 0.4.0a0", async () => {
    listedTools = [tool({ version: "0.4.0a0", latestVersion: "0.4.0" })];
    const s = await store();
    await realRefresh!();
    expect(s.getState().tools[0].updateAvailable).toBe(true);
    expect(s.getState().tools[0].latestVersion).toBe("0.4.0");

    listedTools = [tool({ version: "0.3.5", updateAvailable: false, latestVersion: "0.3.5" })];
    await realRefresh!();
    expect(s.getState().tools[0].updateAvailable).toBe(true);
    expect(s.getState().tools[0].latestVersion).toBe("0.4.0a0");
  });
});

describe("the update check", () => {
  it("does not announce a release at or above the 0.5 cap", async () => {
    listedTools = [tool({ version: "0.4.0a0", latestVersion: "0.5.0" })];
    const s = await store();
    await s.getState().checkSleapNnUpdateAndNotify();
    expect(toasts).toEqual([]);
    expect(s.getState().tools[0].updateAvailable).toBeNull();
    expect(s.getState().tools[0].latestVersion).toBeNull();
    expect(s.getState().lastNotifiedSleapNnVersion).toBeNull();
  });

  it("still announces a release within 0.4", async () => {
    listedTools = [tool({ version: "0.4.0a0", latestVersion: "0.4.0" })];
    const s = await store();
    await s.getState().checkSleapNnUpdateAndNotify();
    expect(toasts).toEqual(["sleap-nn v0.4.0 is available"]);
    expect(s.getState().tools[0].latestVersion).toBe("0.4.0");
  });
});

describe("sleap-nn channel toggle, pre-release detection, and PyPI/sleap-io tracking", () => {
  it("classifies PEP 440 pre-releases from the version string alone", () => {
    expect(isPep440Prerelease("0.4.0a0")).toBe(true);
    expect(isPep440Prerelease("0.4.0b1")).toBe(true);
    expect(isPep440Prerelease("0.4.0rc0")).toBe(true);
    expect(isPep440Prerelease("0.4.0.dev0")).toBe(true);
    expect(isPep440Prerelease("0.10.0a0")).toBe(true);
    expect(isPep440Prerelease("0.3.5")).toBe(false);
    expect(isPep440Prerelease("0.4.0")).toBe(false);
    expect(isPep440Prerelease("0.4.0.post1")).toBe(false);
    expect(isPep440Prerelease("0.9.6")).toBe(false);
    expect(isPep440Prerelease(null)).toBe(false);
  });

  it("builds stable channel install specs without --with sleap-io", () => {
    expect(SLEAP_NN_STABLE_SPECIFIER).toBe("<0.5");
    expect(sleapNnInstallSpec(["torch-cpu"], "stable")).toBe(
      "sleap-nn[torch-cpu]<0.5"
    );
    expect(sleapNnUvExtraArgs([], "stable")).toEqual(["--torch-backend=auto"]);
    expect(sleapNnUvExtraArgs(["--upgrade"], "stable")).toEqual([
      "--upgrade",
      "--torch-backend=auto",
    ]);
  });

  it("picks the right latest PyPI sleap-nn and sleap-io versions per channel", () => {
    const nnVersions = ["0.3.4", "0.3.5", "0.4.0a0", "0.4.0a1", "0.5.0a0", "0.5.0"];
    expect(pickLatestSleapNnVersion(nnVersions, "stable")).toBe("0.3.5");
    expect(pickLatestSleapNnVersion(nnVersions, "prerelease")).toBe("0.4.0a1");
    expect(pickLatestSleapNnVersion([...nnVersions, "0.4.0"], "stable")).toBe("0.4.0");
    expect(pickLatestSleapNnVersion([...nnVersions, "0.4.0"], "prerelease")).toBe("0.4.0");

    const ioVersions = ["0.9.5", "0.9.6", "0.10.0a0", "0.10.0a1", "0.10.0", "0.11.0a0"];
    // sleap-nn 0.3.5 cannot install sleap-io 0.10.x, so cap at <0.10
    expect(pickLatestSleapIoVersion(ioVersions, "stable", "0.3.5")).toBe("0.9.6");
    // sleap-nn 0.4.0 on stable picks stable 0.10.0 (<0.11)
    expect(pickLatestSleapIoVersion(ioVersions, "stable", "0.4.0")).toBe("0.10.0");
    // pre-release channel picks newest <0.11 including alphas
    expect(
      pickLatestSleapIoVersion(["0.9.6", "0.10.0a0", "0.10.0a1"], "prerelease", "0.4.0a0")
    ).toBe("0.10.0a1");
  });

  it("reconciles PyPI updates, channel downgrades, and --with sleap-io updates", () => {
    const pypi: PyPiPackageVersions = {
      sleapNn: ["0.3.5", "0.4.0a0", "0.4.0a1"],
      sleapIo: ["0.9.6", "0.10.0a0", "0.10.0a1"],
      error: null,
    };

    // Newer alpha on prerelease channel
    const nnAlpha = reconcileSleapNnTool(
      tool({ version: "0.4.0a0", updateAvailable: false, latestVersion: "0.4.0a0" }),
      "prerelease",
      pypi
    );
    expect(nnAlpha.updateAvailable).toBe(true);
    expect(nnAlpha.latestVersion).toBe("0.4.0a1");

    // Switching from 0.4.0a0 to stable (0.3.5) is a channel switch, NOT an update toast
    const nnToStable = reconcileSleapNnTool(
      tool({ version: "0.4.0a0", updateAvailable: false, latestVersion: "0.4.0a0" }),
      "stable",
      pypi
    );
    expect(nnToStable.updateAvailable).toBe(false);
    const switchStatus = resolveSleapNnStatus({
      tool: nnToStable,
      channel: "stable",
      pypi,
      installedSleapIoVersion: "0.10.0a0",
    });
    expect(switchStatus.isSwitchDowngrade).toBe(true);
    expect(switchStatus.sleapNnUpdateAvailable).toBe(false);
    expect(switchStatus.targetVersion).toBe("0.3.5");
    expect(switchStatus.installedIsPrerelease).toBe(true);

    // sleap-nn is up to date at 0.4.0a1, but bundled sleap-io 0.10.0a0 -> 0.10.0a1
    const ioUpdateStatus = resolveSleapNnStatus({
      tool: tool({ version: "0.4.0a1", updateAvailable: false, latestVersion: "0.4.0a1" }),
      channel: "prerelease",
      pypi,
      installedSleapIoVersion: "0.10.0a0",
    });
    expect(ioUpdateStatus.sleapNnUpdateAvailable).toBe(false);
    expect(ioUpdateStatus.sleapIoUpdateAvailable).toBe(true);
    expect(ioUpdateStatus.targetSleapIoVersion).toBe("0.10.0a1");

    // sleap-nn 0.3.5 + sleap-io 0.9.6 on stable does NOT flag sleap-io 0.10.0 as compatible
    const stable035Status = resolveSleapNnStatus({
      tool: tool({ version: "0.3.5", updateAvailable: false, latestVersion: "0.3.5" }),
      channel: "stable",
      pypi: { sleapNn: ["0.3.5", "0.4.0a0"], sleapIo: ["0.9.6", "0.10.0"], error: null },
      installedSleapIoVersion: "0.9.6",
    });
    expect(stable035Status.sleapNnUpdateAvailable).toBe(false);
    expect(stable035Status.sleapIoUpdateAvailable).toBe(false);
  });

  it("installs and switches channels in environmentStore without nagging on stable", async () => {
    mockPypiVersions = {
      sleapNn: ["0.3.5", "0.4.0a0"],
      sleapIo: ["0.9.6", "0.10.0a0"],
      error: null,
    };
    listedTools = [
      tool({ version: "0.3.5", updateAvailable: false, latestVersion: "0.3.5" }),
    ];
    const s = await store();
    s.getState().setSleapNnChannel("stable");
    expect(s.getState().sleapNnChannel).toBe("stable");
    expect(s.getState().sleapNnChannelExplicitlySet).toBe(true);
    expect(s.getState().tools[0].updateAvailable).toBe(false);

    // Startup update check on stable does not toast about 0.4.0a0
    await s.getState().checkSleapNnUpdateAndNotify();
    expect(toasts).toEqual([]);

    // Fresh install on stable omits --with sleap-io
    await s.getState().doInstallTool("sleap-nn");
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu]<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --torch-backend=auto`,
    ]);

    // Switching from 0.4.0a0 back to stable forces reinstall & keeps extras
    calls.length = 0;
    installedExtras = { ...installedExtras, onnx: true, backbones: true };
    await s.getState().doSwitchSleapNnChannel();
    expect(calls).toEqual([
      `install sleap-nn[torch-cpu,export,backbones]<0.5 --python ${SLEAP_NN_PYTHON_SPEC} --force --torch-backend=auto`,
    ]);
  });
});
