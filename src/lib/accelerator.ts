/**
 * Turns the raw accelerator probe (see `detectAccelerator` in
 * platform/backend.ts) into the label/value rows the Environment panel shows
 * under sleap-nn.
 *
 * The distinction that matters here is "nothing to fix" vs "something to fix":
 * a machine with no GPU at all is not broken, it's just a CPU box, so it gets a
 * neutral light. An NVIDIA driver present while torch reports `cpu` IS broken
 * (almost always a CPU-only torch wheel), and so is a driver too old for the
 * CUDA the installed torch was built against — both get a warning light and a
 * hint saying what to do.
 */

import type { AcceleratorInfo } from "@/platform/backend";

/** `ok` = accelerator usable, `warn` = fixable problem, `none` = CPU-only machine. */
export type AcceleratorLevel = "ok" | "warn" | "none" | "unknown";

export interface AcceleratorRow {
  label: string;
  value: string;
}

export interface AcceleratorSummary {
  level: AcceleratorLevel;
  /** Value of the "Accelerator" row, e.g. "CUDA · 2 GPUs". */
  label: string;
  /**
   * Further label/value rows, in display order. Only what's known and
   * relevant: PyTorch whenever it's reported, CUDA and driver on NVIDIA.
   */
  rows: AcceleratorRow[];
  /** Per-device descriptions; CUDA only (torch exposes no list for MPS). */
  devices: string[];
  /**
   * Platform name for the row's tooltip. Deliberately not given a row of its
   * own: the accelerator already implies the OS (MPS means a Mac), so a
   * "Platform" row would spend a line restating it.
   */
  platform: string;
  /** What's wrong and what to do about it; `null` when nothing is. */
  hint: string | null;
}

const OS_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const NVIDIA_DRIVERS_URL = "https://www.nvidia.com/drivers";

function pluralGpus(count: number): string {
  return `${count} GPU${count === 1 ? "" : "s"}`;
}

export function summarizeAccelerator(
  info: AcceleratorInfo
): AcceleratorSummary {
  const platform = OS_LABEL[info.os] ?? info.os;
  const rows: AcceleratorRow[] = [];
  if (info.torchVersion) rows.push({ label: "PyTorch", value: info.torchVersion });

  if (info.error || !info.accelerator) {
    return {
      level: "unknown",
      label: "Unknown",
      rows,
      devices: [],
      platform,
      hint: info.error ?? "sleap-nn didn't report an accelerator.",
    };
  }

  if (info.accelerator === "cuda") {
    if (info.cudaVersion) rows.push({ label: "CUDA", value: info.cudaVersion });
    // A too-old driver still leaves torch.cuda.is_available() true, so this is
    // a warning ON TOP of a working CUDA setup, not instead of one: it's what
    // makes training fail later, at kernel-launch time. The requirement goes
    // on the Driver row rather than into the accelerator label, so the label
    // stays scannable and the numbers sit next to each other.
    const stale = info.driverCompatible === false;
    if (info.driverVersion) {
      rows.push({
        label: "Driver",
        value: stale
          ? `${info.driverVersion} → needs ${info.driverMinRequired}`
          : info.driverVersion,
      });
    }
    return {
      level: stale ? "warn" : "ok",
      label: `CUDA · ${pluralGpus(info.gpuCount)}`,
      rows,
      devices: info.gpus,
      platform,
      hint: stale
        ? `NVIDIA driver ${info.driverVersion} is older than ${info.driverMinRequired}, the minimum for CUDA ${info.cudaVersion}. Update it at ${NVIDIA_DRIVERS_URL}.`
        : null,
    };
  }

  if (info.accelerator === "mps") {
    // Deliberately no device count: sleap-nn reports gpuCount 1 for MPS as
    // Lightning's `devices=1` convention, but Metal exposes a single unified
    // GPU that isn't enumerable, so "1 GPU" would imply a countable set that
    // doesn't exist. torch gives no per-device list for MPS either, hence no
    // `devices` entries.
    return {
      level: "ok",
      label: "MPS (Apple Silicon)",
      rows,
      devices: [],
      platform,
      hint: null,
    };
  }

  // accelerator === "cpu"
  if (info.driverVersion) {
    rows.push({ label: "Driver", value: info.driverVersion });
    return {
      level: "warn",
      label: "CPU only (GPU not usable)",
      rows,
      devices: [],
      platform,
      hint: `An NVIDIA driver (${info.driverVersion}) is installed, but the PyTorch in this sleap-nn can't use CUDA — it's most likely a CPU-only build. Reinstall sleap-nn to pick up a CUDA build.`,
    };
  }
  return {
    level: "none",
    label: "CPU only",
    rows,
    devices: [],
    platform,
    hint:
      info.os === "macos"
        ? "No Metal GPU available to PyTorch on this Mac. Training will run on the CPU."
        : "No NVIDIA GPU or driver found on this machine. Training will run on the CPU.",
  };
}
