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
