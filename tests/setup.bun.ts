/**
 * Preloaded by `bun test` (see bunfig.toml).
 *
 * Provides a DOM (happy-dom) for @testing-library/react and wires the
 * @testing-library/jest-dom matchers onto bun:test's `expect`.
 *
 * Unlike vitest (which isolates each test file in its own worker), `bun test`
 * runs every file in a single process and shares one global object. Registering
 * happy-dom once would leak DOM state across files and the global `document`
 * gets torn down between files. Instead we register a fresh DOM before each
 * test and unregister it after, so every test starts from a clean document.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

GlobalRegistrator.register();

// Vite normally injects import.meta.env.BASE_URL; under bun test it maps to
// process.env, so provide the dev-server base path the app expects ("/").
process.env.BASE_URL = "/";

expect.extend(matchers as Parameters<typeof expect.extend>[0]);
