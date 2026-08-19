import { describe, expect, test } from "bun:test";
import { sessionLogsToPrune } from "@/lib/diagnostics/sessionLog";
import {
  assembleDiagnosticsBundle,
  inferTutorialStage,
  type AssembleInputs,
} from "@/lib/diagnostics/collectDiagnostics";

describe("sessionLogsToPrune — retention policy", () => {
  const files = [
    "session-100-aaaa.log",
    "session-300-cccc.log",
    "session-200-bbbb.log",
    "not-a-session.txt",
    "draft-manifest.json",
  ];

  test("keeps the newest N previous logs, prunes older", () => {
    // keepPrevious = 1 → keep the newest (300), prune 200 and 100.
    expect(new Set(sessionLogsToPrune(files, 1))).toEqual(
      new Set(["session-200-bbbb.log", "session-100-aaaa.log"]),
    );
  });

  test("keepPrevious = 0 prunes every session log", () => {
    expect(new Set(sessionLogsToPrune(files, 0))).toEqual(
      new Set([
        "session-300-cccc.log",
        "session-200-bbbb.log",
        "session-100-aaaa.log",
      ]),
    );
  });

  test("keeps all when keepPrevious exceeds count", () => {
    expect(sessionLogsToPrune(files, 10)).toEqual([]);
  });

  test("ignores non-session files (never prunes them)", () => {
    const pruned = sessionLogsToPrune(files, 0);
    expect(pruned).not.toContain("not-a-session.txt");
    expect(pruned).not.toContain("draft-manifest.json");
  });
});

describe("inferTutorialStage", () => {
  const base = {
    videoCount: 0,
    skeletonNodeCount: 0,
    userLabeledFrameCount: 0,
    predictedInstanceCount: 0,
    trackCount: 0,
  };

  test("empty project", () => {
    expect(inferTutorialStage(base)).toBe("empty-project");
  });
  test("video added, no skeleton", () => {
    expect(inferTutorialStage({ ...base, videoCount: 1 })).toBe("video-added");
  });
  test("skeleton built, no labels", () => {
    expect(
      inferTutorialStage({ ...base, videoCount: 1, skeletonNodeCount: 5 }),
    ).toBe("skeleton-built");
  });
  test("labeling, no predictions", () => {
    expect(
      inferTutorialStage({
        ...base,
        videoCount: 1,
        skeletonNodeCount: 5,
        userLabeledFrameCount: 3,
      }),
    ).toBe("labeling");
  });
  test("predictions, no tracks", () => {
    expect(
      inferTutorialStage({
        ...base,
        videoCount: 1,
        skeletonNodeCount: 5,
        userLabeledFrameCount: 3,
        predictedInstanceCount: 10,
      }),
    ).toBe("predictions");
  });
  test("tracking/proofreading", () => {
    expect(
      inferTutorialStage({
        videoCount: 1,
        skeletonNodeCount: 5,
        userLabeledFrameCount: 3,
        predictedInstanceCount: 10,
        trackCount: 2,
      }),
    ).toBe("tracking-proofreading");
  });
});

describe("assembleDiagnosticsBundle", () => {
  const inputs: AssembleInputs = {
    meta: {
      installId: "install-1",
      sessionId: "session-1",
      bootTimestamp: "2026-08-18T00:00:00.000Z",
      collectedTimestamp: "2026-08-18T00:05:00.000Z",
      appName: "sleap-app",
      appVersion: "0.1.0",
      userAgent: "test",
      runtime: "tauri",
      gpu: "cpu",
      gpuStats: null,
      uv: null,
      python: null,
      sleapNnVersion: "0.3.2",
      project: {
        stage: "labeling",
        path: "/Users/a/flies.slp",
        videoCount: 1,
        skeletonNodeCount: 13,
        userLabeledFrameCount: 5,
        predictedInstanceCount: 0,
        trackCount: 0,
      },
    },
    training: [
      {
        label: "centroid",
        status: "completed",
        epoch: 4,
        maxEpochs: 5,
        finalLoss: 4.3e-5,
        finalValLoss: 6.01e-5,
        bestValLoss: 6.01e-5,
        meanEpochTimeSec: 14.2,
        epochs: [
          { epoch: 0, trainLoss: 0.0028, valLoss: null },
          { epoch: 4, trainLoss: 4.3e-5, valLoss: 6.01e-5 },
        ],
        runDir: "/Users/a/models/centroid",
      },
    ],
    sessionLogs: [{ name: "session-1.log", content: "[log] hi\n" }],
    consoleBuffer: [{ timestamp: 1, level: "error", args: "boom" }],
    notifications: [],
    trainingLog: ["epoch 1"],
    inferenceLog: [],
    draftManifest: [{ displayName: "flies" }],
    projectDraft: null,
  };

  test("adds a human-readable _whatIsThis header", () => {
    const b = assembleDiagnosticsBundle(inputs);
    expect(typeof b._whatIsThis).toBe("string");
    expect(b._whatIsThis).toContain("NOT contain video frames");
  });

  test("passes through every section verbatim", () => {
    const b = assembleDiagnosticsBundle(inputs);
    expect(b.meta.installId).toBe("install-1");
    expect(b.consoleBuffer).toEqual(inputs.consoleBuffer);
    expect(b.trainingLog).toEqual(["epoch 1"]);
    expect(b.sessionLogs).toEqual(inputs.sessionLogs);
    expect(b.draftManifest).toEqual(inputs.draftManifest);
    // structured training metrics (not parsed from log text)
    expect(b.training[0].finalLoss).toBe(4.3e-5);
    expect(b.training[0].epochs.length).toBe(2);
  });

  test("projectDraft is null when not opted in, present when attached", () => {
    expect(assembleDiagnosticsBundle(inputs).projectDraft).toBeNull();
    const withDraft = assembleDiagnosticsBundle({
      ...inputs,
      projectDraft: { filename: "flies.imageless.slp", base64: "AAAA" },
    });
    expect(withDraft.projectDraft?.filename).toBe("flies.imageless.slp");
  });
});
