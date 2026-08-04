/**
 * Introspecting a trained sleap-nn model directory, so an imported model can be
 * used without the session that produced it and a wrong pick is caught before
 * sleap-nn is spawned.
 *
 * The fixture mirrors a REAL trained config, which differs from the shipped
 * baseline profiles in one way that matters: every head is listed, with the
 * inactive ones explicitly `null`.
 */

import { describe, it, expect } from "../bun-test";
import {
  describeModelConfig,
  pipelineForHeadTypes,
  modelCompatWarnings,
  headTypeLabel,
  type ModelDirInfo,
} from "@/lib/modelDirInfo";

/** Shaped like models/<run>/training_config.yaml from a real run. */
function trainedConfig({
  head = "centroid",
  backbone = "unet",
  inChannels = 3,
  runName = "centroid_20260727200401.",
}: {
  head?: string;
  backbone?: string;
  inChannels?: number;
  runName?: string | null;
} = {}): string {
  const heads = ["single_instance", "centroid", "centered_instance", "bottomup"];
  const headBlock = heads
    .map((h) =>
      h === head
        ? `    ${h}:\n      confmaps:\n        sigma: 2.5`
        : `    ${h}: null`,
    )
    .join("\n");
  return `
model_config:
  init_weights: default
  backbone_config:
    ${backbone}:
      in_channels: ${inChannels}
      kernel_size: 3
  head_configs:
${headBlock}
trainer_config:
  ckpt_dir: /models
  run_name: ${runName === null ? "null" : runName}
`;
}

function info(overrides: Partial<ModelDirInfo>): ModelDirInfo {
  return {
    path: "/m",
    headType: null,
    backbone: null,
    inChannels: null,
    runName: null,
    error: null,
    ...overrides,
  };
}

describe("describeModelConfig", () => {
  it("picks the ACTIVE head, skipping the explicit nulls a real config carries", () => {
    // The regression a naive "first key" implementation would hit: the fixture
    // lists single_instance first, as null.
    const d = describeModelConfig(trainedConfig({ head: "centroid" }))!;
    expect(d.headType).toBe("centroid");
  });

  it("reads backbone, input channels and run name", () => {
    const d = describeModelConfig(
      trainedConfig({ head: "bottomup", backbone: "convnext", inChannels: 3, runName: "bu_1" }),
    )!;
    expect(d.headType).toBe("bottomup");
    expect(d.backbone).toBe("convnext");
    expect(d.inChannels).toBe(3);
    expect(d.runName).toBe("bu_1");
  });

  it("returns nulls rather than throwing on a config missing the sections", () => {
    const d = describeModelConfig("foo: 1")!;
    expect(d).not.toBeNull();
    expect(d.headType).toBeNull();
    expect(d.backbone).toBeNull();
  });

  it("returns null for input that isn't a config at all", () => {
    expect(describeModelConfig("")).toBeNull();
    expect(describeModelConfig("just a string")).toBeNull();
    expect(describeModelConfig("a: [unclosed")).toBeNull();
  });
});

describe("pipelineForHeadTypes", () => {
  it("pairs centroid + centered_instance into top-down, in either order", () => {
    expect(pipelineForHeadTypes(["centroid", "centered_instance"]).pipeline).toBe("top-down");
    expect(pipelineForHeadTypes(["centered_instance", "centroid"]).pipeline).toBe("top-down");
  });

  it("maps each single-model pipeline", () => {
    expect(pipelineForHeadTypes(["bottomup"]).pipeline).toBe("bottom-up");
    expect(pipelineForHeadTypes(["single_instance"]).pipeline).toBe("single-animal");
    expect(pipelineForHeadTypes(["multi_class_bottomup"]).pipeline).toBe("bottom-up-id");
    // A lone centroid localizes without posing — the AL locator path.
    expect(pipelineForHeadTypes(["centroid"]).pipeline).toBe("centroid");
  });

  it("maps centroid + multi_class_topdown to top-down-id", () => {
    expect(pipelineForHeadTypes(["centroid", "multi_class_topdown"]).pipeline).toBe("top-down-id");
  });

  it("rejects a lone centered-instance with an actionable reason", () => {
    const r = pipelineForHeadTypes(["centered_instance"]);
    expect(r.pipeline).toBeNull();
    expect(r.problem).toContain("Centroid");
  });

  it("rejects two models of the same head", () => {
    const r = pipelineForHeadTypes(["centroid", "centroid"]);
    expect(r.pipeline).toBeNull();
    expect(r.problem).toContain("Two Centroid");
  });

  it("rejects a nonsense combination", () => {
    const r = pipelineForHeadTypes(["bottomup", "single_instance"]);
    expect(r.pipeline).toBeNull();
    expect(r.problem).toBeTruthy();
  });

  it("treats nothing-selected as incomplete, not an error", () => {
    expect(pipelineForHeadTypes([])).toEqual({ pipeline: null, problem: null });
  });

  it("flags selections it couldn't identify", () => {
    const r = pipelineForHeadTypes([null]);
    expect(r.pipeline).toBeNull();
    expect(r.problem).toContain("Couldn't identify");
  });
});

describe("modelCompatWarnings", () => {
  it("catches a grayscale model paired with an RGB one", () => {
    const w = modelCompatWarnings([info({ inChannels: 1 }), info({ inChannels: 3 })]);
    expect(w.join(" ")).toContain("input channels");
  });

  it("catches mixed backbones", () => {
    const w = modelCompatWarnings([info({ backbone: "unet" }), info({ backbone: "convnext" })]);
    expect(w.join(" ")).toContain("Mixed backbones");
  });

  it("is silent on a consistent pair", () => {
    expect(
      modelCompatWarnings([
        info({ backbone: "unet", inChannels: 1 }),
        info({ backbone: "unet", inChannels: 1 }),
      ]),
    ).toEqual([]);
  });

  it("ignores models it couldn't introspect rather than warning about nulls", () => {
    expect(modelCompatWarnings([info({ backbone: "unet", inChannels: 1 }), info({})])).toEqual([]);
  });
});

describe("headTypeLabel", () => {
  it("labels every known head and degrades gracefully", () => {
    expect(headTypeLabel("centered_instance")).toBe("Centered Instance");
    expect(headTypeLabel("multi_class_bottomup")).toBe("Bottom-Up ID");
    expect(headTypeLabel(null)).toBe("Unknown");
    expect(headTypeLabel("something_new")).toBe("Unknown");
  });
});
