/**
 * Whether sleap-nn's optional TensorRT extra can be offered on this machine.
 *
 * Two independent gates, and they fail for different reasons worth telling the
 * user apart:
 *  - PLATFORM: sleap-nn marks both tensorrt deps `linux`/`win32` only, so on
 *    macOS the extra resolves to nothing — requesting it would install nothing
 *    and report success, which is worse than refusing.
 *  - HARDWARE: TensorRT is NVIDIA-only, so even on Linux/Windows it's dead
 *    weight without a CUDA device. Same rule the export dialog applies to its
 *    TensorRT format options.
 */

import type { AcceleratorInfo, SleapNnExtras } from "@/platform/backend";

export interface TensorrtAvailability {
  enabled: boolean;
  /** Short parenthetical for the checkbox label; `null` when available. */
  note: string | null;
}

export function tensorrtAvailability(
  extras: SleapNnExtras | null,
  accelerator: AcceleratorInfo | null
): TensorrtAvailability {
  if (!extras) return { enabled: false, note: null };

  // Already installed: stay toggleable regardless of what the gates now say,
  // or an extra installed elsewhere (or before a GPU was removed) could never
  // be unchecked and removed.
  if (extras.tensorrt) return { enabled: true, note: null };

  if (!extras.tensorrtSupported) {
    return { enabled: false, note: "Linux/Windows only" };
  }

  // The accelerator probe imports torch and so resolves well after the extras
  // probe; until it reports, don't assert the GPU is missing.
  if (accelerator?.accelerator && accelerator.accelerator !== "cuda") {
    return { enabled: false, note: "needs an NVIDIA GPU" };
  }

  return { enabled: true, note: null };
}

export interface ExtrasSelection {
  onnx: boolean;
  tensorrt: boolean;
}

/**
 * Apply one checkbox change to an extras selection, enforcing the installer's
 * rule that TensorRT always ships with ONNX (`installExtras` adds `export`
 * whenever `tensorrt` is asked for, because TensorRT export is built on the
 * ONNX toolchain).
 *
 * Rather than let the boxes claim a combination the installer would silently
 * rewrite, the implication is applied here and stays visible: checking
 * TensorRT pulls ONNX in, and unchecking ONNX drops TensorRT with it.
 */
export function toggleExtra(
  sel: ExtrasSelection,
  extra: "onnx" | "tensorrt",
  value: boolean
): ExtrasSelection {
  if (extra === "onnx") {
    return { onnx: value, tensorrt: value ? sel.tensorrt : false };
  }
  return { onnx: value || sel.onnx, tensorrt: value };
}
