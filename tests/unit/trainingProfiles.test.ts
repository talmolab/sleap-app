import { describe, it, expect } from "../bun-test";
import yaml from "js-yaml";
import {
  BASELINE_PROFILES,
  getBaselineProfilesForHead,
  getDefaultProfileForHead,
  slotToHeadType,
} from "@/lib/trainingProfiles";

describe("trainingProfiles", () => {
  it("has 10 baseline profiles", () => {
    expect(BASELINE_PROFILES).toHaveLength(10);
  });

  it("returns correct profiles for centroid", () => {
    const profiles = getBaselineProfilesForHead("centroid");
    expect(profiles).toHaveLength(2);
    expect(profiles[0].filename).toContain("medium_rf");
    expect(profiles[1].filename).toContain("large_rf");
  });

  it("centroid's large-RF profile doubles max_stride and drops filters_rate, matching every other head's medium→large delta", () => {
    interface UnetDoc {
      model_config: { backbone_config: { unet: { max_stride: number; filters_rate: number; filters: number } } };
    }
    const [medium, large] = getBaselineProfilesForHead("centroid");
    const mediumDoc = yaml.load(medium.content) as UnetDoc;
    const largeDoc = yaml.load(large.content) as UnetDoc;
    const mediumUnet = mediumDoc.model_config.backbone_config.unet;
    const largeUnet = largeDoc.model_config.backbone_config.unet;
    expect(mediumUnet.max_stride).toBe(16);
    expect(largeUnet.max_stride).toBe(32);
    expect(mediumUnet.filters_rate).toBe(2.0);
    expect(largeUnet.filters_rate).toBe(1.5);
    // Everything else about the backbone should be unchanged between tiers.
    expect(largeUnet.filters).toBe(mediumUnet.filters);
  });

  it("returns correct profiles for centered_instance", () => {
    const profiles = getBaselineProfilesForHead("centered_instance");
    expect(profiles).toHaveLength(2);
    expect(profiles[0].filename).toContain("medium_rf");
    expect(profiles[1].filename).toContain("large_rf");
  });

  it("returns correct profiles for bottomup", () => {
    expect(getBaselineProfilesForHead("bottomup")).toHaveLength(2);
  });

  it("returns correct profiles for single_instance", () => {
    expect(getBaselineProfilesForHead("single_instance")).toHaveLength(2);
  });

  it("returns correct profiles for multi_class_bottomup", () => {
    const profiles = getBaselineProfilesForHead("multi_class_bottomup");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].filename).toBe("baseline.multi_class_bottomup.yaml");
  });

  it("returns correct profiles for multi_class_topdown", () => {
    const profiles = getBaselineProfilesForHead("multi_class_topdown");
    expect(profiles).toHaveLength(1);
    expect(profiles[0].filename).toBe("baseline.multi_class_topdown.yaml");
  });

  it("returns the medium-RF profile as centroid's default", () => {
    const p = getDefaultProfileForHead("centroid");
    expect(p).toBeDefined();
    expect(p!.filename).toBe("baseline_medium_rf.centroid.yaml");
  });

  it("returns undefined for unknown head type", () => {
    expect(getDefaultProfileForHead("nonexistent")).toBeUndefined();
  });

  it("every profile has a unique, non-empty display label", () => {
    const labels = BASELINE_PROFILES.map((p) => p.label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("RF-tiered profiles' labels say which tier they are; single-profile heads' don't", () => {
    for (const p of BASELINE_PROFILES) {
      const isTiered = getBaselineProfilesForHead(p.headType).length > 1;
      expect(p.label.includes("RF)"), p.filename).toBe(isTiered);
    }
  });

  it("all profiles have non-empty content", () => {
    for (const p of BASELINE_PROFILES) {
      expect(p.content.length).toBeGreaterThan(100);
    }
  });

  it("every profile defaults to the Cache in Memory pipeline with 2 dataloader workers", () => {
    // Matches legacy SLEAP's own default (talmolab/sleap commit a03bacc53,
    // "Change default data pipeline to 'Cache in Memory' for better
    // performance") — `data_pipeline_fw: torch_dataset` ("Stream", no
    // caching) silently overrode the app-level `defaultHyperparams.dataPipeline
    // = "memory"` for every freshly-loaded pipeline, since baseline profiles
    // are what actually get parsed. num_workers only helps with a caching
    // pipeline (sleap-nn: "0 means loaded in main process"), so it's bumped
    // from 0 to 2 alongside it.
    for (const p of BASELINE_PROFILES) {
      const doc = yaml.load(p.content) as {
        data_config: { data_pipeline_fw: string };
        trainer_config: {
          train_data_loader: { num_workers: number };
          val_data_loader: { num_workers: number };
        };
      };
      expect(doc.data_config.data_pipeline_fw, p.filename).toBe("torch_dataset_cache_img_memory");
      expect(doc.trainer_config.train_data_loader.num_workers, p.filename).toBe(2);
      expect(doc.trainer_config.val_data_loader.num_workers, p.filename).toBe(2);
    }
  });

  describe("slotToHeadType", () => {
    it("maps centroid slot directly", () => {
      expect(slotToHeadType("top_down", "centroid")).toBe("centroid");
    });

    it("maps centered_instance slot directly", () => {
      expect(slotToHeadType("top_down", "centered_instance")).toBe("centered_instance");
    });

    it("maps config slot for single_animal to single_instance", () => {
      expect(slotToHeadType("single_animal", "config")).toBe("single_instance");
    });

    it("maps config slot for bottom_up to bottomup", () => {
      expect(slotToHeadType("bottom_up", "config")).toBe("bottomup");
    });

    it("maps config slot for bottom_up_id to multi_class_bottomup", () => {
      expect(slotToHeadType("bottom_up_id", "config")).toBe("multi_class_bottomup");
    });

    it("maps config slot for top_down_id to multi_class_topdown", () => {
      expect(slotToHeadType("top_down_id", "config")).toBe("multi_class_topdown");
    });
  });
});
