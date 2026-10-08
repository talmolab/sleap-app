// Must stay the first import: fixes an invalid navigator.language ("C" under
// LANG=C on Linux WebKitGTK) before uPlot reads it at module load. See the file.
import "./lib/localeGuard";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { VizWindow } from "./components/monitors/VizWindow";
import "./index.css";
import { loadSlp, Mp4BoxVideoBackend, UserCentroid, PredictedCentroid } from "@talmolab/sleap-io.js";
import { useAppStore } from "./stores/appStore";
import { commandContext } from "./commands";
import { loadProjectFromFile } from "./lib/loadProject";
import { initDiagnostics } from "./lib/diagnostics";
import { useActiveLearningStore } from "./stores/activeLearningStore";
import { buildRoundQueue, offerReview, runRoundInference } from "./lib/activeLearning/roundEngine";
import { frameKey } from "./lib/activeLearning/reviewQueue";

// Expose key APIs on window for testing/debugging (typed in src/globals.d.ts,
// which the test tsconfig also includes so tests/e2e can use window.sleap).
window.sleap = {
  loadSlp,
  Mp4BoxVideoBackend,
  store: useAppStore,
  commandContext,
  loadProjectFromFile,
  UserCentroid,
  PredictedCentroid,
  activeLearning: { store: useActiveLearningStore, buildRoundQueue, offerReview, runRoundInference, frameKey },
};

// A window spawned with `?viz=<runDir>` is a standalone visualization window
// (its own isolated heap) — render just the viz viewer, not the full editor.
const vizParams = new URLSearchParams(window.location.search);
const vizRunDir = vizParams.get("viz");

// Diagnostics (session log + global error capture) for the main app window only —
// the viz window is a short-lived isolated heap. Best-effort; never blocks boot.
if (!vizRunDir) {
  void initDiagnostics();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {vizRunDir ? (
      <VizWindow runDir={vizRunDir} title={vizParams.get("vizTitle") ?? "Model"} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
