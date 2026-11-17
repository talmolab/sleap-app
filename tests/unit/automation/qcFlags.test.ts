// Why: Claude refers to flags by id across calls, so ids must be stable and skip instances the user ignored.
import { describe, it, expect, beforeEach } from "../../bun-test";
import type { QcFinding } from "@/lib/analyze/labelQc";
import { useQcStore } from "@/stores/qcStore";
import { setQcReviewedBackend, memoryBackend } from "@/lib/qcReviewed";
import { listQcFlags, parseFlagId, findQcFlag } from "@/automation/qcFlags";
import { AutomationError } from "@/automation/errors";
import { loadFixtureWithOneInstance, anomalyAt } from "../helpers/automationFixture";

let video: ReturnType<typeof loadFixtureWithOneInstance>["video"];

async function seed(findings: Omit<QcFinding, "video">[], anomalies: ReturnType<typeof anomalyAt>[]) {
  const project = loadFixtureWithOneInstance();
  video = project.video;
  await Promise.resolve(); // loadDismissed
  useQcStore.setState({
    labels: project.labels,
    state: "done",
    findings: findings.map((f) => ({ ...f, video })),
    anomaly: { instances: anomalies, featureNames: [], gmmThreshold: 0.95 },
    threshold: 0.7,
    rescored: new Map(),
  });
  return project;
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AutomationError).code;
  }
  return null;
};

describe("listQcFlags", () => {
  beforeEach(() => {
    setQcReviewedBackend(memoryBackend());
    useQcStore.getState().reset();
  });

  // Why: Claude must be told to ask for a QC run instead of getting an empty list.
  it("errors when Label QC hasn't run", () => {
    loadFixtureWithOneInstance();
    expect(codeOf(() => listQcFlags())).toBe("NO_QC_RUN");
  });

  // Why: the same results must give the same ids, or Claude's later calls would miss.
  it("gives stable ids for anomaly and rule flags", async () => {
    await seed(
      [
        { kind: "duplicate", message: "Duplicate", videoIdx: 0, frameIdx: 20, instanceIdx: 1 },
        { kind: "incomplete_frame", message: "Incomplete", videoIdx: 0, frameIdx: 20 },
      ],
      [anomalyAt(10, 0, 0.9), anomalyAt(20, 0, 0.5)],
    );
    const ids = listQcFlags().map((f) => f.id);
    expect(ids).toEqual(["v0:f20:i1:duplicate", "v0:f20:i-:incomplete_frame", "v0:f10:i0:anomaly"]);
    expect(listQcFlags().map((f) => f.id)).toEqual(ids);
    const a = listQcFlags().find((f) => f.kind === "anomaly")!;
    expect(a.score).toBe(0.9);
    expect(a.nodes).toEqual(["nose"]);
  });

  // Why: two findings of one kind on one instance still need different ids.
  it("suffixes repeated ids", async () => {
    await seed(
      [
        { kind: "out_of_range", message: "a", videoIdx: 0, frameIdx: 10, instanceIdx: 0 },
        { kind: "out_of_range", message: "b", videoIdx: 0, frameIdx: 10, instanceIdx: 0 },
      ],
      [],
    );
    expect(listQcFlags().map((f) => f.id)).toEqual(["v0:f10:i0:out_of_range", "v0:f10:i0:out_of_range#2"]);
    expect(findQcFlag("v0:f10:i0:out_of_range#2").message).toBe("b");
  });

  // Why: a flag the user ignored (key 3) must not come back to Claude.
  it("leaves out instances marked OK", async () => {
    await seed([], [anomalyAt(10, 0, 0.9), anomalyAt(20, 1, 0.8)]);
    useQcStore.getState().markOk(0, 10, 0);
    expect(listQcFlags().map((f) => f.id)).toEqual(["v0:f20:i1:anomaly"]);
  });

  // Why: a bad or stale id should say what went wrong, not crash.
  it("parses ids and rejects bad ones", async () => {
    expect(parseFlagId("v0:f120:i1:joint_angle")).toEqual({ videoIdx: 0, frameIdx: 120, instIdx: 1, kind: "joint_angle" });
    expect(parseFlagId("v2:f3:i-:incomplete_frame").instIdx).toBeNull();
    expect(codeOf(() => parseFlagId("frame 3"))).toBe("BAD_INPUT");
    await seed([], [anomalyAt(10, 0, 0.9)]);
    expect(codeOf(() => findQcFlag("v0:f99:i0:anomaly"))).toBe("UNKNOWN_FLAG");
  });
});
