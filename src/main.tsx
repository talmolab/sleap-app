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

// [isolation] TEMPORARY probe for PR #202 (localhost-origin) cross-platform validation.
// Confirms the packaged app is crossOriginIsolated (→ SharedArrayBuffer → the >1GB
// .pkg.slp range reader) and reports the actual origin. Remove before un-drafting.
// grep "[isolation]" to find both this and the Rust-side port log.
console.log("[isolation]", {
  origin: location.origin,
  crossOriginIsolated: globalThis.crossOriginIsolated,
  hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  isSecureContext: globalThis.isSecureContext,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
