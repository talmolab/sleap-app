import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { loadSlp, Mp4BoxVideoBackend } from "@talmolab/sleap-io.js";
import { useAppStore } from "./stores/appStore";
import { commandContext } from "./commands";
import { loadProjectFromFile } from "./lib/loadProject";

// Expose key APIs on window for testing/debugging
declare global {
  interface Window {
    sleap: {
      loadSlp: typeof loadSlp;
      Mp4BoxVideoBackend: typeof Mp4BoxVideoBackend;
      store: typeof useAppStore;
      commandContext: typeof commandContext;
      loadProjectFromFile: typeof loadProjectFromFile;
    };
  }
}
window.sleap = { loadSlp, Mp4BoxVideoBackend, store: useAppStore, commandContext, loadProjectFromFile };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
