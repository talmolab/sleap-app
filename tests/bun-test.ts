/**
 * Compatibility shim so the existing vitest-style unit tests run under
 * bun's native test runner (`bun test`).
 *
 * Tests import the bun:test primitives (describe/it/expect/...) and a small
 * `vi` object that maps the handful of vitest APIs the suite uses onto their
 * bun:test equivalents. This keeps the test bodies unchanged while dropping
 * the vitest/vite-node dependency (which cannot run under bun on Windows).
 *
 * This module also registers happy-dom and the jest-dom matchers. The suite
 * runs with `bun test --isolate`, which gives every test file a fresh global
 * object and module registry (so `mock.module` mocks made by one file never
 * leak into another). The bunfig `preload` (tests/setup.bun.ts) registers the
 * DOM in bun's original global before any test module loads -- early enough
 * for `@testing-library/dom`'s `screen` (which binds to `document.body` at
 * module-load time). This shim re-registers in each isolated per-file global
 * as a belt-and-braces measure (guarded so it is a no-op if a DOM already
 * exists), guaranteeing `document` is present everywhere.
 *
 * Registration happens at the very top, before `@testing-library/dom` (pulled
 * in transitively below) is evaluated, because its `screen` export binds to
 * `document.body` at module-load time.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

// Vite normally injects import.meta.env.BASE_URL; under bun test it maps to
// process.env, so provide the dev-server base path the app expects ("/").
process.env.BASE_URL = "/";

// Bun maps import.meta.env to process.env (empty by default). vitest used to
// set MODE=test / DEV=true / PROD=false; without these, import.meta.env.DEV
// (e.g. in src/components/layout/ErrorBoundary.tsx) would be falsy under bun,
// diverging from the vitest behaviour the tests were written against. Mirror
// vitest here (DEV truthy). Do NOT set NODE_ENV. Use ??= so explicit env wins.
process.env.MODE ??= "test";
process.env.DEV ??= "true";
process.env.PROD ??= "";

import { mock, spyOn, expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers as Parameters<typeof expect.extend>[0]);

export {
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "bun:test";

/**
 * Tracks globals replaced via `vi.stubGlobal` so `vi.unstubAllGlobals` can
 * restore the original values (matching vitest's behaviour). Stores the
 * pre-stub descriptor (or `undefined` for keys that did not previously exist).
 */
const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();

/** Minimal `vi` shim covering the vitest APIs used in this repo. */
export const vi = {
  /** vitest `vi.fn` -> bun `mock`. */
  fn: (impl?: (...args: never[]) => unknown) =>
    mock(impl ?? (() => undefined)),

  /** vitest `vi.spyOn` -> bun `spyOn`. */
  spyOn,

  /**
   * vitest `vi.mock(specifier, factory)` -> bun `mock.module`.
   *
   * CAVEAT: bun's `mock.module` is NOT hoisted above static `import`
   * statements the way vitest's `vi.mock` is. The mock only takes effect for
   * modules imported AFTER this call runs. Therefore any test that uses
   * `vi.mock` MUST import the module-under-test DYNAMICALLY (via
   * `await import(...)`) inside the test/`beforeEach`, AFTER calling
   * `vi.mock`, rather than with a top-of-file static import (as the
   * components/dialogs tests already do). A static import would be evaluated
   * before the mock is registered and would bind to the real module.
   */
  mock: (specifier: string, factory: () => unknown) =>
    mock.module(specifier, factory),

  /** vitest `vi.stubGlobal` -> assignment on globalThis, remembering the prior value. */
  stubGlobal: (name: string, value: unknown) => {
    if (!stubbedGlobals.has(name)) {
      stubbedGlobals.set(
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      );
    }
    (globalThis as Record<string, unknown>)[name] = value;
  },

  /** vitest `vi.unstubAllGlobals` -> restore every value replaced by stubGlobal. */
  unstubAllGlobals: () => {
    for (const [name, descriptor] of stubbedGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
    stubbedGlobals.clear();
  },
};
