/**
 * Preloaded by `bun test` (see bunfig.toml `[test].preload`).
 *
 * This preload runs once, in bun's original global, BEFORE any test file's
 * module graph is evaluated. That ordering is the reason it exists: it
 * registers happy-dom (so a global `document`/`document.body` is present) and
 * wires up the @testing-library/jest-dom matchers before `@testing-library/dom`
 * is ever loaded. `@testing-library/dom`'s `screen` export binds to
 * `document.body` at module-load time (a throwing stub if no DOM exists yet),
 * so the DOM must be registered before that module is first imported by any
 * test file. The per-file `tests/bun-test.ts` shim re-registers in each
 * isolated global, but a test file's static `import` statements (including
 * `@testing-library/react` -> `screen`) are evaluated as part of resolving the
 * shim import, so the shim alone cannot guarantee the DOM is up early enough --
 * this preload closes that gap.
 *
 * register() is guarded so it is a no-op if a DOM was somehow already
 * registered (e.g. by the shim in a non-isolated run); it does not tear down
 * or recreate the DOM per test.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

// Vite normally injects import.meta.env.BASE_URL; under bun test it maps to
// process.env, so provide the dev-server base path the app expects ("/").
process.env.BASE_URL = "/";

// Bun maps import.meta.env to process.env (empty by default). vitest used to
// set MODE=test / DEV=true / PROD=false; without these, import.meta.env.DEV
// (e.g. in src/components/layout/ErrorBoundary.tsx) would be falsy under bun.
// Mirror vitest here (DEV truthy). Do NOT set NODE_ENV. Use ??= so explicit
// env wins. Kept in sync with tests/bun-test.ts.
process.env.MODE ??= "test";
process.env.DEV ??= "true";
process.env.PROD ??= "";

expect.extend(matchers as Parameters<typeof expect.extend>[0]);
