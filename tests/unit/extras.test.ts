import { describe, it, expect } from "../bun-test";
import { tensorrtAvailability, toggleExtra } from "@/lib/extras";
import type { AcceleratorInfo, SleapNnExtras } from "@/platform/backend";

function extras(overrides: Partial<SleapNnExtras> = {}): SleapNnExtras {
  return {
    onnx: false,
    tensorrt: false,
    tensorrtSupported: true,
    error: null,
    ...overrides,
  };
}

function accel(
  accelerator: AcceleratorInfo["accelerator"]
): AcceleratorInfo {
  return {
    accelerator,
    gpuCount: 0,
    gpus: [],
    torchVersion: null,
    cudaVersion: null,
    driverVersion: null,
    driverCompatible: null,
    driverMinRequired: null,
    os: "linux",
    error: null,
  };
}

describe("tensorrtAvailability", () => {
  it("offers TensorRT on a CUDA Linux/Windows host", () => {
    const a = tensorrtAvailability(extras(), accel("cuda"));
    expect(a.enabled).toBe(true);
    expect(a.note).toBeNull();
  });

  // The Mac case: sleap-nn's tensorrt deps are marked linux/win only, so the
  // extra would resolve to nothing at all.
  it("greys out TensorRT when the platform can't install it", () => {
    const a = tensorrtAvailability(
      extras({ tensorrtSupported: false }),
      accel("mps")
    );
    expect(a.enabled).toBe(false);
    expect(a.note).toBe("Linux/Windows only");
  });

  it("greys out TensorRT on a supported platform with no NVIDIA GPU", () => {
    const a = tensorrtAvailability(extras(), accel("cpu"));
    expect(a.enabled).toBe(false);
    expect(a.note).toBe("needs an NVIDIA GPU");
  });

  // The extras probe resolves well before the torch-importing accelerator
  // probe; a not-yet-known accelerator must not read as "no GPU".
  it("does not claim the GPU is missing before the accelerator is known", () => {
    expect(tensorrtAvailability(extras(), null).enabled).toBe(true);
    expect(tensorrtAvailability(extras(), accel(null)).enabled).toBe(true);
  });

  // Otherwise an already-installed extra could never be unchecked to remove it.
  it("keeps an installed TensorRT toggleable even when the gates now refuse", () => {
    const a = tensorrtAvailability(
      extras({ tensorrt: true, tensorrtSupported: false }),
      accel("mps")
    );
    expect(a.enabled).toBe(true);
    expect(a.note).toBeNull();
  });

  it("stays disabled until the extras probe reports", () => {
    const a = tensorrtAvailability(null, accel("cuda"));
    expect(a.enabled).toBe(false);
    expect(a.note).toBeNull();
  });
});

describe("toggleExtra", () => {
  // installExtras always adds `export` when `tensorrt` is requested, so the
  // boxes must never claim a TensorRT-without-ONNX selection.
  it("pulls ONNX in when TensorRT is checked", () => {
    expect(
      toggleExtra({ onnx: false, tensorrt: false }, "tensorrt", true)
    ).toEqual({ onnx: true, tensorrt: true });
  });

  it("drops TensorRT when ONNX is unchecked", () => {
    expect(toggleExtra({ onnx: true, tensorrt: true }, "onnx", false)).toEqual({
      onnx: false,
      tensorrt: false,
    });
  });

  it("leaves ONNX alone when TensorRT is unchecked", () => {
    expect(
      toggleExtra({ onnx: true, tensorrt: true }, "tensorrt", false)
    ).toEqual({ onnx: true, tensorrt: false });
  });

  it("checks ONNX on its own without touching TensorRT", () => {
    expect(toggleExtra({ onnx: false, tensorrt: false }, "onnx", true)).toEqual({
      onnx: true,
      tensorrt: false,
    });
  });

  it("never yields TensorRT without ONNX, for any input", () => {
    for (const onnx of [false, true]) {
      for (const tensorrt of [false, true]) {
        for (const extra of ["onnx", "tensorrt"] as const) {
          for (const value of [false, true]) {
            const out = toggleExtra({ onnx, tensorrt }, extra, value);
            if (out.tensorrt) expect(out.onnx).toBe(true);
          }
        }
      }
    }
  });
});
