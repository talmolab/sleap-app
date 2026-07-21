import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { loadSlp, Mp4BoxVideoBackend, UserCentroid, PredictedCentroid } from "@talmolab/sleap-io.js";
import { useAppStore } from "./stores/appStore";
import { commandContext } from "./commands";
import { loadProjectFromFile } from "./lib/loadProject";

// Expose key APIs on window for testing/debugging (typed in src/globals.d.ts,
// which the test tsconfig also includes so tests/e2e can use window.sleap).
window.sleap = { loadSlp, Mp4BoxVideoBackend, store: useAppStore, commandContext, loadProjectFromFile, UserCentroid, PredictedCentroid };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
