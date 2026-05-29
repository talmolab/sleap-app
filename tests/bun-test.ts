/**
 * Compatibility shim so the existing vitest-style unit tests run under
 * bun's native test runner (`bun test`).
 *
 * Tests import the bun:test primitives (describe/it/expect/...) and a small
 * `vi` object that maps the handful of vitest APIs the suite uses onto their
 * bun:test equivalents. This keeps the test bodies unchanged while dropping
 * the vitest/vite-node dependency (which cannot run under bun on Windows).
 *
 * This module also (re-)registers happy-dom and the jest-dom matchers. The
 * suite runs with `bun test --isolate`, which gives every test file a fresh
 * global object and module registry (so `mock.module` mocks made by one file
 * never leak into another). A bunfig `preload` would register the DOM only in
 * the original global, which the isolated per-file globals cannot see. Because
 * every test file imports this shim, registering here runs once per file in
 * that file's own fresh global, guaranteeing `document` is present everywhere.
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

  /** vitest `vi.mock(specifier, factory)` -> bun `mock.module`. */
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
