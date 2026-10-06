import { describe, it, expect } from "../bun-test";
import { summarizeAccelerator } from "@/lib/accelerator";
import type { AcceleratorInfo } from "@/platform/backend";

function info(overrides: Partial<AcceleratorInfo> = {}): AcceleratorInfo {
  return {
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
    ...overrides,
  };
}

/** The panel renders `rows` as a label/value grid; assert on it as pairs. */
function rowMap(rows: { label: string; value: string }[]) {
  return Object.fromEntries(rows.map((r) => [r.label, r.value]));
}

describe("summarizeAccelerator", () => {
  it("reports CUDA with a green light and the GPU count", () => {
    const s = summarizeAccelerator(
      info({
        accelerator: "cuda",
        gpuCount: 2,
        gpus: ["NVIDIA RTX 4090 (23.6 GB)", "NVIDIA RTX 4090 (23.6 GB)"],
        torchVersion: "2.9.0+cu130",
        cudaVersion: "13.0",
        driverVersion: "580.65.06",
        driverCompatible: true,
        driverMinRequired: "580.65.06",
      })
    );
    expect(s.level).toBe("ok");
    expect(s.label).toBe("CUDA · 2 GPUs");
    expect(s.devices).toHaveLength(2);
    expect(rowMap(s.rows)).toEqual({
      PyTorch: "2.9.0+cu130",
      CUDA: "13.0",
      Driver: "580.65.06",
    });
    expect(s.platform).toBe("Linux");
    expect(s.hint).toBeNull();
  });

  it("singularizes a one-GPU machine", () => {
    const s = summarizeAccelerator(
      info({ accelerator: "cuda", gpuCount: 1, os: "windows" })
    );
    expect(s.label).toBe("CUDA · 1 GPU");
    expect(s.platform).toBe("Windows");
  });

  // The requirement belongs next to the installed version on the Driver row,
  // so the accelerator label stays scannable.
  it("puts a too-old driver on the Driver row and warns, keeping the GPU count", () => {
    const s = summarizeAccelerator(
      info({
        accelerator: "cuda",
        gpuCount: 1,
        cudaVersion: "13.0",
        driverVersion: "560.28.03",
        driverCompatible: false,
        driverMinRequired: "580.65.06",
      })
    );
    expect(s.level).toBe("warn");
    expect(s.label).toBe("CUDA · 1 GPU");
    expect(rowMap(s.rows).Driver).toBe("560.28.03 → needs 580.65.06");
    expect(s.hint).toContain("580.65.06");
    expect(s.hint).toContain("nvidia.com/drivers");
  });

  it("reports MPS on Apple Silicon", () => {
    const s = summarizeAccelerator(
      info({
        accelerator: "mps",
        gpuCount: 1,
        os: "macos",
        torchVersion: "2.9.0",
      })
    );
    expect(s.level).toBe("ok");
    expect(s.label).toBe("MPS (Apple Silicon)");
    expect(s.devices).toEqual([]);
    expect(rowMap(s.rows)).toEqual({ PyTorch: "2.9.0" });
    expect(s.platform).toBe("macOS");
    expect(s.hint).toBeNull();
    // sleap-nn reports gpuCount 1 for MPS (Lightning's `devices=1`), but
    // Metal's single unified GPU isn't a countable set — a device count must
    // never reach the label on a Mac.
    expect(s.label).not.toMatch(/\d/);
    expect(s.label).not.toContain("1 GPU");
  });

  // The case this indicator exists for: the machine HAS an NVIDIA GPU (a
  // driver is installed) but the installed torch can't use it.
  it("warns and points at a reinstall when a driver is present but CUDA isn't usable", () => {
    const s = summarizeAccelerator(
      info({
        accelerator: "cpu",
        torchVersion: "2.9.0+cpu",
        driverVersion: "580.65.06",
      })
    );
    expect(s.level).toBe("warn");
    expect(s.label).toBe("CPU only (GPU not usable)");
    expect(rowMap(s.rows).Driver).toBe("580.65.06");
    expect(s.hint).toContain("Reinstall sleap-nn");
  });

  it("stays neutral on a machine that simply has no GPU", () => {
    const s = summarizeAccelerator(info({ accelerator: "cpu" }));
    expect(s.level).toBe("none");
    expect(s.label).toBe("CPU only");
    expect(s.rows).toEqual([]);
    expect(s.hint).toContain("No NVIDIA GPU");
  });

  it("uses Mac wording for a CPU-only Mac", () => {
    const s = summarizeAccelerator(info({ accelerator: "cpu", os: "macos" }));
    expect(s.level).toBe("none");
    expect(s.hint).toContain("Metal");
  });

  it("surfaces the probe's own error verbatim", () => {
    const s = summarizeAccelerator(
      info({ accelerator: null, error: "sleap-nn environment not found" })
    );
    expect(s.level).toBe("unknown");
    expect(s.label).toBe("Unknown");
    expect(s.hint).toBe("sleap-nn environment not found");
  });

  it("treats a missing accelerator with no error as unknown too", () => {
    const s = summarizeAccelerator(info({ accelerator: null }));
    expect(s.level).toBe("unknown");
    expect(s.hint).toContain("didn't report an accelerator");
  });

  // Whatever went wrong, a reported torch version is still worth showing.
  it("keeps the PyTorch row even when the accelerator is unknown", () => {
    const s = summarizeAccelerator(
      info({ accelerator: null, error: "boom", torchVersion: "2.9.0" })
    );
    expect(rowMap(s.rows)).toEqual({ PyTorch: "2.9.0" });
  });

  it("omits rows for values the probe didn't report", () => {
    const s = summarizeAccelerator(info({ accelerator: "cuda", gpuCount: 1 }));
    expect(s.rows).toEqual([]);
  });
});
