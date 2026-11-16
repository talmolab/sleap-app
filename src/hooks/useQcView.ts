/**
 * Label QC results as every view shows them: switched-off detectors and
 * hidden issue types left out (qc/settings.ts `filterQcResults`). Use this,
 * not the raw store fields, wherever flags are shown, so the dialog, panel,
 * Review window and canvas agree.
 */
import { useMemo } from "react";
import { useQcStore } from "@/stores/qcStore";
import { filterQcResults, type QcView } from "@/lib/analyze/qc/settings";

export function useQcView(): QcView {
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const settings = useQcStore((s) => s.settings);
  const hiddenIssues = useQcStore((s) => s.hiddenIssues);
  return useMemo(
    () => filterQcResults(findings, anomaly, settings, hiddenIssues),
    [findings, anomaly, settings, hiddenIssues],
  );
}
