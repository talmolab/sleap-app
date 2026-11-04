/**
 * The Environment panel's "Switch to sleap-connect": an install under the
 * worker's old PyPI name (`sleap-rtc`, up to 0.0.7) is uninstalled, then
 * `sleap-connect` installed — in that order, since both provide the same
 * executables, and only if the uninstall worked.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";

type Event = { event: string; data: { line?: string; success?: boolean } };

const calls: string[] = [];
let uninstallSucceeds = true;

vi.mock("@/platform/index", () => ({ isTauri: true }));
const unused = async () => {
  throw new Error("not used by this test");
};

vi.mock("@/platform/backend", () => ({
  detectUv: unused,
  detectGpu: unused,
  detectAccelerator: unused,
  detectSleapNnExtras: unused,
  listUvTools: unused,
  listPythonInterpreters: unused,
  listDownloadablePythons: unused,
  checkPython: unused,
  installPython: unused,
  upgradeUvTool: unused,
  updateUv: unused,
  installUv: unused,
  uninstallUvTool: async (pkg: string, onEvent: (e: Event) => void) => {
    calls.push(`uninstall ${pkg}`);
    onEvent({ event: "finished", data: { success: uninstallSucceeds } });
  },
  installUvTool: async (
    pkg: string,
    _python: string | null,
    force: boolean,
    onEvent: (e: Event) => void
  ) => {
    calls.push(`install ${pkg}${force ? " --force" : ""}`);
    onEvent({ event: "finished", data: { success: true } });
  },
}));

async function store() {
  const { useEnvironmentStore } = await import("@/stores/environmentStore");
  useEnvironmentStore.setState({ refresh: async () => {} });
  return useEnvironmentStore;
}

describe("switchToSleapConnect", () => {
  beforeEach(() => {
    calls.length = 0;
    uninstallSucceeds = true;
  });

  it("uninstalls sleap-rtc, then installs sleap-connect", async () => {
    const s = await store();

    await s.getState().switchToSleapConnect();

    expect(calls).toEqual(["uninstall sleap-rtc", "install sleap-connect"]);
    expect(s.getState().installStatus).toBe("done");
  });

  it("doesn't install if the uninstall failed", async () => {
    uninstallSucceeds = false;
    const s = await store();

    await s.getState().switchToSleapConnect();

    expect(calls).toEqual(["uninstall sleap-rtc"]);
    expect(s.getState().installStatus).toBe("error");
  });
});
