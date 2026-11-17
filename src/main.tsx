// Must stay the first import: fixes an invalid navigator.language ("C" under
// LANG=C on Linux WebKitGTK) before uPlot reads it at module load. See the file.
import "./lib/localeGuard";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { VizWindow } from "./components/monitors/VizWindow";
import "./index.css";
import { loadSlp, Mp4BoxVideoBackend } from "@talmolab/sleap-io.js";
import { useAppStore } from "./stores/appStore";
import { commandContext } from "./commands";
import { loadProjectFromFile } from "./lib/loadProject";
import { initDiagnostics } from "./lib/diagnostics";
import { isTauri } from "./platform/index";
import { registry as automationRegistry } from "./automation/tools";
import type { ToolInfo, ToolResult } from "./automation/registry";

// Expose key APIs on window for testing/debugging
declare global {
  interface Window {
    sleap: {
      loadSlp: typeof loadSlp;
      Mp4BoxVideoBackend: typeof Mp4BoxVideoBackend;
      store: typeof useAppStore;
      commandContext: typeof commandContext;
      loadProjectFromFile: typeof loadProjectFromFile;
      /** Claude connector tools (QC review): list them, or call one by name. */
      automation: {
        tools: () => ToolInfo[];
        call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
      };
    };
  }
}
window.sleap = {
  loadSlp,
  Mp4BoxVideoBackend,
  store: useAppStore,
  commandContext,
  loadProjectFromFile,
  automation: {
    tools: () => automationRegistry.list(),
    call: (name, args) => automationRegistry.call(name, args ?? {}),
  },
};

// A window spawned with `?viz=<runDir>` is a standalone visualization window
// (its own isolated heap) — render just the viz viewer, not the full editor.
const vizParams = new URLSearchParams(window.location.search);
const vizRunDir = vizParams.get("viz");

// Diagnostics (session log + global error capture) for the main app window only —
// the viz window is a short-lived isolated heap. Best-effort; never blocks boot.
if (!vizRunDir) {
  void initDiagnostics();
  // "Allow Claude to control SLEAP" was left on: start the connector again.
  if (isTauri) {
    void import("./stores/claudeConnectorStore").then((m) => m.useClaudeConnectorStore.getState().resume());
  }
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
