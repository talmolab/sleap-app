---
name: pr
description: >
  Create a well-structured GitHub PR for sleap-app with proper branching, testing, and
  documentation. Use when the user says "create a PR", "make a PR", "open a pull request",
  or wants to submit changes for review. Handles the full workflow: branch creation,
  implementation, testing, linting, committing, and PR creation with a description that
  matches this repo's conventions.
---

# Create a GitHub Pull Request (sleap-app)

## Overview

This skill guides the PR workflow for this repo from branch creation to PR submission.
`main` is protected — all changes go through a branch, PR, and **squash merge** (see
`CLAUDE.md`). The project is bun-only (no npm/Node toolchain); see `.bun-version` for the
pinned version.

## Step 1: Branch Setup

### Pull latest main
```bash
git checkout main
git pull origin main
```

### Create a branch
Name it `{type}/{description}`, matching the convention used across this repo's merged PRs:

| Type | Use for |
|---|---|
| `feat/` | New functionality |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring, no behavior change |
| `docs/` | Documentation-only changes |
| `test/` | Test additions/improvements only |
| `chore/` | Dependency bumps, tooling, maintenance |

Examples from recent history: `fix/opfs-embedded-video-signature`, `feat/browser-locate-videos-folder`,
`chore/bump-io-0.5.7`, `docs/readme-linux-prereq-and-deployment`.

```bash
git checkout -b fix/descriptive-name
```

## Step 2: Understand the Problem

Before coding, identify:
1. **Core problem**: what issue are we solving, and why now?
2. **Scope**: which files/modules are affected? Does it touch both the browser and Tauri
   desktop code paths (many I/O paths branch on runtime environment)?
3. **Approach**: implementation strategy, and whether it should route through
   `sleap-io.js` (check `../sleap-io.js` if a local sibling checkout exists, or
   https://iojs.sleap.ai/usage.md / api.md) rather than reimplementing data-model logic.
4. **Edge cases**: predicted vs. user instances, browser vs. desktop, large-file paths, etc.

If there's an associated GitHub issue, fetch it for context:
```bash
gh issue view <issue-number>
```

## Step 3: Implement Changes

- Make focused, incremental changes; follow existing patterns in the surrounding code.
- Use the `@/` path alias for imports (`@/` → `./src/`).
- Never hand-edit `src/components/ui/` — it's shadcn/ui-generated. Add new components with
  `bunx shadcn@latest add <component>`.
- Default to no comments; only add one where the *why* isn't obvious from the code itself.
- Don't add speculative abstractions, feature flags, or error handling for cases that can't
  happen — match the codebase's existing minimalism.

## Step 4: Write/Update Tests

### Unit tests
- Location: `tests/unit/`, one `*.test.ts`/`*.test.tsx` file generally mirroring the
  `src/` module it covers (e.g. `src/stores/appStore.ts` → `tests/unit/appStore.test.ts`).
- Import the test primitives from the repo's `bun:test` wrapper, not `bun:test` directly:
  ```ts
  import { describe, it, expect, beforeEach } from "../bun-test";
  ```
- Cover new functionality, edge cases, and both success and failure paths. Reset any shared
  Zustand store state between tests (see `resetStore()` patterns in existing store tests).

### E2E tests
- Location: `tests/e2e/` (Playwright). Add/update one when the change affects a
  user-facing browser flow that unit tests can't exercise end-to-end.

### Desktop-only behavior
- If the change is specific to the Tauri desktop build (native file I/O, byte-range reads,
  etc.), verify it in a real Tauri window with `tauri-pilot` rather than assuming Playwright
  coverage is enough — see `.claude/skills/tauri-pilot/SKILL.md`.

## Step 5: Lint

```bash
bun run lint
```

This isn't part of CI today, but a clean `eslint .` run is expected before every PR in this
repo (visible in prior PR descriptions). Fix real errors; pre-existing warnings unrelated to
your change don't need to be cleaned up as a drive-by.

## Step 6: Type-check, Build, and Test

Run the same gate CI runs (see `test.yml`), in this order, so nothing surprises you after
pushing:
```bash
bun run build           # tsc -b && vite build — type-checks src/ and produces the prod build
bun run typecheck:tests # tsc -p tsconfig.test.json --noEmit — type-checks tests/
bun run test            # bun test tests/unit --isolate — the full unit suite
```
A bare `bun test` (without `--isolate`) currently panics bun 1.3.14 — always use
`bun run test`.

## Step 7: Commit Changes

Follow the repo's git commit conventions (see the top-level git instructions for the
staging/heredoc/commit-message mechanics). Use **conventional commit** format matching this
repo's history:
```
<type>(<scope>): <short description>

<optional longer description — the why, not the what>
```
Types seen in this repo: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`. Scope is
usually the affected subsystem (`video`, `save`, `labels`, `opfs`, `canvas`, `deps`, ...).

Only commit when the user asks. Never `--no-verify` or skip hooks.

## Step 8: Push to GitHub

```bash
git push -u origin <branch-name>
```

## Step 9: Create the Pull Request

Base branch is **`main`**. This repo's merged PRs follow a `## Summary` (or `## What` for
larger features) opening section, then whatever sections fit the change
(`## Root cause`, `## Fix`, `## Changes`, `## Testing` / `## Test plan`, `## Notes / follow-ups`),
and end with the Claude Code footer:

```bash
gh pr create --base main --title "<type>(<scope>): <short description>" --body "$(cat <<'EOF'
## Summary

<1-3 sentences/bullets: what changed and why>

## Changes

- <bullet list of the concrete changes, file/module level>

## Testing

- <unit tests added/updated, and what they cover>
- <manual verification done — browser, Tauri desktop, or both>
- <gate results: bun run build / typecheck:tests / test — pass/fail counts>

## Related Issues

Closes #<issue-number> (if applicable)

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

For a fix, prefer leading with `## Root cause` before `## Fix` so reviewers understand *why*
before *what*. For a large/multi-part feature, `## What` with subsections reads better than
a flat bullet list — look at a couple of recent merged PRs with `gh pr view <number> --json body -q '.body'`
for tone if unsure.

### If updating an existing PR

```bash
gh pr view <pr-number> --json body -q '.body'
gh pr edit <pr-number> --body "<new body>"
```

### Draft / blocked PRs

If the PR depends on an unreleased dependency (e.g. an unmerged `sleap-io.js` change) or
should not be merged yet, open it as a draft and put a `> ⚠️` warning callout at the very
top of the body explaining what's blocking it and what needs to happen before merge.

## PR Description Checklist

- [ ] Summary explains the "what" and "why" (root cause first, for bug fixes)
- [ ] All significant changes are documented
- [ ] Testing section covers unit tests, manual verification, and the build/lint/test gate
- [ ] Breaking changes or follow-up work called out explicitly
- [ ] Related issues linked (`Closes #N`)
- [ ] Draft + blocking-dependency warning added if not yet mergeable

## CI Checks

PRs into `main` trigger `.github/workflows/test.yml` on `ubuntu-latest`:
- `bun install --frozen-lockfile`
- `bun run build` (type check + production build)
- `bun run typecheck:tests`
- `bun run test` (full unit suite)

Note: **lint is not currently run in CI** — run `bun run lint` locally anyway, since it's
expected clean by convention. `tests/e2e` (Playwright) is also not run in CI; use it for
local verification of browser-facing flows.

`.github/workflows/build.yml` (desktop installers) and `.github/workflows/deploy.yml`
(`app.sleap.ai`) only run on release / push-to-main / manual dispatch — they don't gate PRs.

## Quick Reference Commands

```bash
# Branch setup
git checkout main && git pull origin main
git checkout -b fix/my-fix

# Local CI-equivalent gate
bun run lint
bun run build
bun run typecheck:tests
bun run test

# Push and create PR
git push -u origin <branch>
gh pr create --base main --title "type(scope): description" --body "..."

# View/edit existing PR
gh pr view <number>
gh pr edit <number> --body "New description"

# View linked issue
gh issue view <number>

# Look at recent merged PRs for tone/structure
gh pr list --state merged --limit 10 --json number,title,headRefName
gh pr view <number> --json body -q '.body'
```
