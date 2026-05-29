// Augments bun:test's `expect`/`Matchers` with the @testing-library/jest-dom
// matchers (toBeInTheDocument, toBeDisabled, ...) for the tests typecheck
// (tsconfig.test.json). The shim (tests/bun-test.ts) wires these matchers in at
// runtime via expect.extend; this brings the matching type declarations into
// scope so the assertions type-check.
//
// jest-dom ships a `bun.d.ts` that does exactly this `declare module
// "bun:test"` augmentation, but its package.json `exports` map exposes no
// `./bun` (or `./types/*`) subpath, so a bare `/// <reference types=... />`
// cannot resolve it under moduleResolution:"bundler". Re-declare the
// augmentation here, importing the matcher types from the package's public
// `./matchers` entry point.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "bun:test" {
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<unknown, T> {}
}
