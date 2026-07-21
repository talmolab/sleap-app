/** Build-time constant injected by Vite `define` (see vite.config.ts). */
declare const __APP_VERSION__: string;

/**
 * Debug/E2E bridge assigned in src/main.tsx. Declared here (not in main.tsx)
 * so tsconfig.test.json — whose `include` doesn't cover src — can type the
 * `window.sleap` calls in tests/e2e via its explicit src/globals.d.ts entry.
 */
interface Window {
  sleap: {
    loadSlp: typeof import("@talmolab/sleap-io.js").loadSlp;
    Mp4BoxVideoBackend: typeof import("@talmolab/sleap-io.js").Mp4BoxVideoBackend;
    store: typeof import("./stores/appStore").useAppStore;
    commandContext: typeof import("./commands").commandContext;
    loadProjectFromFile: typeof import("./lib/loadProject").loadProjectFromFile;
    UserCentroid: typeof import("@talmolab/sleap-io.js").UserCentroid;
    PredictedCentroid: typeof import("@talmolab/sleap-io.js").PredictedCentroid;
  };
}
