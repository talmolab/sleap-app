import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";

// When running under Tauri (`bun run tauri:dev`), TAURI_ENV_PLATFORM is set.
// In that case, use real Tauri plugin packages instead of browser stubs.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// Detect whether sleap-io.js is linked to a local out-of-tree checkout
// (e.g. `bun add file:../sleap-io.js` for local development) vs. a normal
// published-package install. Linking can manifest in different ways depending
// on the package manager / OS: a POSIX symlink, a Windows junction, or a real
// directory whose realpath resolves outside this project's node_modules. We
// treat it as linked if it's a symlink OR if its realpath points outside
// node_modules. A normal install resolves inside node_modules -> not linked.
const sleapIoPath = path.resolve(__dirname, "node_modules/@talmolab/sleap-io.js");
const nodeModulesDir = path.join(__dirname, "node_modules");
function detectLinkedSleapIo(): boolean {
  try {
    if (fs.lstatSync(sleapIoPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return true;
    }
    // realpathSync follows junctions/symlinks and normalizes the path; if the
    // resolved location lives outside our node_modules, it's a local link.
    const resolved = fs.realpathSync(sleapIoPath);
    const relative = path.relative(nodeModulesDir, resolved);
    return relative.startsWith("..") || path.isAbsolute(relative);
  } catch {
    // Package not installed (or path inaccessible); treat as a normal install.
    return false;
  }
}
const isLinkedSleapIo = detectLinkedSleapIo();

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // Path alias for shadcn/ui
      "@": path.resolve(__dirname, "./src"),
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

  // When sleap-io.js is linked for local development, exclude it from
  // pre-bundling so Vite serves the linked dist files directly.
  ...(isLinkedSleapIo && {
    optimizeDeps: { exclude: ["@talmolab/sleap-io.js"] },
  }),

  build: {
    chunkSizeWarningLimit: 5000, // h5wasm WASM module is ~4MB
  },

  server: {
    port: 5173,
    strictPort: true,
    // Allow serving files from linked sleap-io.js outside the project root
    ...(isLinkedSleapIo && {
      fs: { allow: [".", fs.realpathSync(sleapIoPath)] },
    }),
  },

  // Tauri expects a fixed port and fails if port is already in use
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
