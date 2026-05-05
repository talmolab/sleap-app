import { describe, it, expect } from "vitest";
import {
  buildMessage,
  parseMessage,
  generateJobId,
  MSG_JOB_SUBMIT,
  MSG_JOB_LOG,
  MSG_AUTH_CHALLENGE,
  MSG_AUTH_RESPONSE,
  MSG_AUTH_SUCCESS,
  MSG_AUTH_FAILURE,
  TrackJobSpec,
  TrainJobSpec,
} from "@/lib/sleapConnect";

describe("sleapConnect protocol helpers", () => {
  describe("buildMessage", () => {
    it("joins parts with separator", () => {
      const msg = buildMessage(MSG_JOB_SUBMIT, "job123", '{"type":"track"}');
      expect(msg).toBe('JOB_SUBMIT::job123::{"type":"track"}');
    });

    it("handles single part", () => {
      expect(buildMessage("PING")).toBe("PING");
    });
  });

  describe("parseMessage", () => {
    it("splits message into parts", () => {
      const parts = parseMessage("JOB_PROGRESS::job123::Processing frame 1");
      expect(parts).toEqual(["JOB_PROGRESS", "job123", "Processing frame 1"]);
    });

    it("handles message with no separator", () => {
      expect(parseMessage("PING")).toEqual(["PING"]);
    });
  });

  describe("generateJobId", () => {
    it("returns a string starting with job_", () => {
      const id = generateJobId();
      expect(id).toMatch(/^job_\d+_[a-z0-9]+$/);
    });

    it("returns unique values", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));
      expect(ids.size).toBe(100);
    });
  });
});

describe("auth and log protocol constants", () => {
  it("exports MSG_JOB_LOG", () => {
    expect(MSG_JOB_LOG).toBe("JOB_LOG");
  });

  it("exports MSG_AUTH_CHALLENGE", () => {
    expect(MSG_AUTH_CHALLENGE).toBe("AUTH_CHALLENGE");
  });

  it("exports MSG_AUTH_RESPONSE", () => {
    expect(MSG_AUTH_RESPONSE).toBe("AUTH_RESPONSE");
  });

  it("exports MSG_AUTH_SUCCESS", () => {
    expect(MSG_AUTH_SUCCESS).toBe("AUTH_SUCCESS");
  });

  it("exports MSG_AUTH_FAILURE", () => {
    expect(MSG_AUTH_FAILURE).toBe("AUTH_FAILURE");
  });
});

describe("JobSpec types include path_mappings", () => {
  it("TrackJobSpec accepts path_mappings", () => {
    const spec: TrackJobSpec = {
      type: "track",
      data_path: "/data/labels.slp",
      model_paths: ["/models/centroid"],
      path_mappings: { "/local/video.mp4": "/worker/video.mp4" },
    };
    expect(spec.path_mappings).toEqual({ "/local/video.mp4": "/worker/video.mp4" });
  });

  it("TrainJobSpec accepts path_mappings", () => {
    const spec: TrainJobSpec = {
      type: "train",
      config_contents: ["yaml content"],
      model_types: ["centroid"],
      labels_path: "/data/labels.slp",
      path_mappings: { "/local/video.mp4": "/worker/video.mp4" },
    };
    expect(spec.path_mappings).toEqual({ "/local/video.mp4": "/worker/video.mp4" });
  });

  it("path_mappings is optional on TrackJobSpec", () => {
    const spec: TrackJobSpec = {
      type: "track",
      data_path: "/data/labels.slp",
      model_paths: ["/models/centroid"],
    };
    expect(spec.path_mappings).toBeUndefined();
  });

  it("path_mappings is optional on TrainJobSpec", () => {
    const spec: TrainJobSpec = {
      type: "train",
      config_contents: ["yaml"],
      model_types: ["centroid"],
      labels_path: "/data/labels.slp",
    };
    expect(spec.path_mappings).toBeUndefined();
  });
});
