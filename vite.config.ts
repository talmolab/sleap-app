import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { existsSync } from "fs";

// When running under Tauri (`npm run tauri dev`), TAURI_ENV_PLATFORM is set.
// In that case, use real Tauri plugin packages instead of browser stubs.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// Resolve h5wasm ESM browser build.
// When using local sleap-io.js (file: link), h5wasm lives in its node_modules.
// When using npm @talmolab/sleap-io.js, h5wasm is hoisted to our node_modules.
const localH5wasm = path.resolve(
  __dirname,
  "../sleap-io.js/node_modules/h5wasm/dist/esm/hdf5_hl.js"
);
const npmH5wasm = path.resolve(
  __dirname,
  "node_modules/h5wasm/dist/esm/hdf5_hl.js"
);
const h5wasmPath = existsSync(localH5wasm) ? localH5wasm : npmH5wasm;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // Path alias for shadcn/ui
      "@": path.resolve(__dirname, "./src"),
      // Redirect both h5wasm imports to the same ESM browser build
      // (sleap-io.js does: `isNode ? import("h5wasm/node") : import("h5wasm")`)
      "h5wasm/node": h5wasmPath,
      h5wasm: h5wasmPath,
      // Stub Node.js 'module' used by h5wasm node build
      module: path.resolve(__dirname, "src/lib/stubs/module.ts"),
      // In browser mode, stub Tauri plugins; in Tauri mode, use real packages
      ...(!isTauri && {
        "@tauri-apps/plugin-fs": path.resolve(
          __dirname,
          "src/lib/stubs/tauri-fs.ts"
        ),
        "@tauri-apps/plugin-dialog": path.resolve(
          __dirname,
          "src/lib/stubs/tauri-dialog.ts"
        ),
      }),
    },
  },

  build: {
    chunkSizeWarningLimit: 5000, // h5wasm WASM module is ~4MB
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  // Tauri expects a fixed port and fails if port is already in use
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
