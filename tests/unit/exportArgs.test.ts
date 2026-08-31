import { describe, it, expect } from "../bun-test";
import { buildExportArgs } from "@/platform/exportArgs";

describe("buildExportArgs", () => {
  it("starts with the `export` subcommand", () => {
    const args = buildExportArgs({ modelPaths: ["/m"], outputDir: "/out", format: "onnx" });
    expect(args[0]).toBe("export");
  });

  it("passes a single model dir positionally, then --output and --format", () => {
    const args = buildExportArgs({ modelPaths: ["/models/single"], outputDir: "/out", format: "onnx" });
    expect(args).toEqual(["export", "/models/single", "--output", "/out", "--format", "onnx"]);
  });

  it("passes BOTH run dirs (positional, in order) for a top-down bundle", () => {
    const args = buildExportArgs({ modelPaths: ["/c", "/ci"], outputDir: "/out", format: "onnx" });
    expect(args.slice(0, 3)).toEqual(["export", "/c", "/ci"]);
  });

  it("emits --precision only for tensorrt, not onnx", () => {
    const onnx = buildExportArgs({ modelPaths: ["/m"], outputDir: "/o", format: "onnx" });
    expect(onnx).not.toContain("--precision");

    const trt = buildExportArgs({ modelPaths: ["/m"], outputDir: "/o", format: "tensorrt", precision: "fp16" });
    expect(trt[trt.indexOf("--precision") + 1]).toBe("fp16");
  });

  it("defaults precision to fp16 for tensorrt when unspecified", () => {
    const trt = buildExportArgs({ modelPaths: ["/m"], outputDir: "/o", format: "tensorrt" });
    expect(trt[trt.indexOf("--precision") + 1]).toBe("fp16");
  });
});
