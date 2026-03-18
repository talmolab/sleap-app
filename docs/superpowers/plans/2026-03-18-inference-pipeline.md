# Phase 2: Inference Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the sleap-label-web Tauri app to `sleap-nn` for running pose estimation inference, including process management, progress streaming, and prediction merging.

**Architecture:** Minimal Rust relay — the frontend drives orchestration (builds CLI args, parses progress JSON, reads output files, merges predictions). Rust provides a generic process runner that spawns commands and streams stdout/stderr via Tauri's Channel API. A standalone `merge()` function handles prediction integration, designed for upstream to sleap-io.js.

**Tech Stack:** Tauri v2 (Rust + TypeScript), React, Zustand, Vitest, @talmolab/sleap-io.js

**Spec:** `docs/superpowers/specs/2026-03-18-inference-pipeline-design.md`

---

## File Structure

### New files:
| File | Responsibility |
|------|---------------|
| `src/lib/merge.ts` | Standalone Labels merge function (upstream candidate for sleap-io.js) |
| `tests/unit/merge.test.ts` | Tests for merge logic |
| `src/stores/inferenceStore.ts` | Zustand store for inference status, progress, log, UI state |
| `tests/unit/inferenceStore.test.ts` | Tests for inference store |
| `src/components/monitors/InferenceMonitor.tsx` | Progress dialog (full + minimized compact bar) |

### Modified files:
| File | Change |
|------|--------|
| `src-tauri/src/environment.rs` | Rename `InstallEvent` → `ProcessEvent`, add `run_python_command` + `cancel_command` |
| `src-tauri/src/lib.rs` | Register new commands + `RunningProcess` managed state |
| `src/platform/backend.ts` | Rename `InstallEvent` → `ProcessEvent`, add `runPythonCommand()` + `cancelCommand()` wrappers |
| `src/stores/environmentStore.ts` | Update `InstallEvent` references to `ProcessEvent` |
| `src/components/panels/EnvironmentPanel.tsx` | Update `InstallEvent` references to `ProcessEvent` (if any) |
| `src/commands/editCommands.ts` | Add `MergePredictionsCommand` |
| `src/components/dialogs/InferenceDialog.tsx` | Wire up to real backend, remove "Coming Soon" |
| `src/components/layout/AppShell.tsx` | Render InferenceMonitor |

---

## Task 1: Rename InstallEvent → ProcessEvent

Small rename to make the streaming event type generic (not install-specific), since it will now be used for inference too.

**Files:**
- Modify: `src-tauri/src/environment.rs:60-67` (enum definition)
- Modify: `src-tauri/src/environment.rs` (all usages)
- Modify: `src/platform/backend.ts:39-42` (TypeScript type)
- Modify: `src/stores/environmentStore.ts` (if it references the type name)

- [ ] **Step 1: Rename in Rust**

In `src-tauri/src/environment.rs`, rename the enum and all references:

```rust
// Line 60-67: Rename InstallEvent → ProcessEvent
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ProcessEvent {
    Stdout { line: String },
    Stderr { line: String },
    Finished { success: bool, code: Option<i32> },
}
```

Update `stream_command` signature (line 98) and all command signatures that use `Channel<InstallEvent>` → `Channel<ProcessEvent>`:
- `stream_command` (line 98)
- `install_python` (line 264)
- `install_uv_tool` (line 276)
- `upgrade_uv_tool` (line 305)
- `update_uv` (line 316)
- `install_uv` (line 326)

- [ ] **Step 2: Rename in TypeScript**

In `src/platform/backend.ts`, rename the type (line 39-42):

```typescript
// Rename InstallEvent → ProcessEvent
export type ProcessEvent =
  | { event: "stdout"; data: { line: string } }
  | { event: "stderr"; data: { line: string } }
  | { event: "finished"; data: { success: boolean; code: number | null } };
```

Update all function signatures that use `InstallEvent` → `ProcessEvent`:
- `streamingInvoke` (line 97)
- `installPython` (line 109)
- `installUvTool` (line 118)
- `upgradeUvTool` (line 133)
- `updateUv` (line 142)
- `installUv` (line 150)

In `src/stores/environmentStore.ts`, update any `InstallEvent` type references to `ProcessEvent` in the import and usage.

- [ ] **Step 3: Verify build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run 2>&1 | tail -20`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/environment.rs src/platform/backend.ts src/stores/environmentStore.ts
git commit -m "refactor: rename InstallEvent to ProcessEvent for generic streaming"
```

---

## Task 2: Add run_python_command and cancel_command (Rust)

Add two new Rust commands for spawning and cancelling long-running processes. Unlike `stream_command`, these retain the `CommandChild` handle for cancellation.

**Files:**
- Modify: `src-tauri/src/environment.rs` (add new commands + RunningProcess state)
- Modify: `src-tauri/src/lib.rs` (register commands + managed state)

- [ ] **Step 1: Add RunningProcess managed state**

In `src-tauri/src/lib.rs`, add a new state struct and register it:

```rust
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// Managed state for tracking a running subprocess (inference, training, etc.)
pub struct RunningProcess(pub Mutex<Option<CommandChild>>);
```

In the `run()` function, add `.manage(RunningProcess(Mutex::new(None)))` to the builder chain (after the existing `.manage(InitialFile(...))` on line 62).

- [ ] **Step 2: Add run_python_command**

In `src-tauri/src/environment.rs`, add:

```rust
use crate::RunningProcess;

#[tauri::command]
pub async fn run_python_command<R: Runtime>(
    app: AppHandle<R>,
    running: tauri::State<'_, RunningProcess>,
    program: String,
    args: Vec<String>,
    on_event: Channel<ProcessEvent>,
) -> Result<bool, String> {
    let (mut rx, child) = app
        .shell()
        .command(&program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    // Store child handle for cancellation
    {
        let mut guard = running.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let mut success = false;
    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                let _ = on_event.send(ProcessEvent::Stdout { line });
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                let _ = on_event.send(ProcessEvent::Stderr { line });
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                success = payload.code == Some(0);
                let _ = on_event.send(ProcessEvent::Finished {
                    success,
                    code: payload.code,
                });
                break;
            }
            _ => {}
        }
    }

    // Clear stored handle
    {
        let mut guard = running.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    Ok(success)
}
```

- [ ] **Step 3: Add cancel_command**

In `src-tauri/src/environment.rs`, add:

```rust
#[tauri::command]
pub async fn cancel_command(
    running: tauri::State<'_, RunningProcess>,
) -> Result<(), String> {
    let mut guard = running.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("Failed to kill process: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Register new commands in lib.rs**

In `src-tauri/src/lib.rs`, add to the `generate_handler!` macro (line 62-73):

```rust
environment::run_python_command,
environment::cancel_command,
```

- [ ] **Step 5: Verify Rust build**

Run: `cd /Users/talmo/code/sleap-label-web/src-tauri && cargo build 2>&1 | tail -20`
Expected: Build succeeds.

**Known risk:** `CommandChild` from `tauri_plugin_shell::process` may not implement `Send`, which would prevent storing it in a `Mutex`. If the build fails with a `Send` bound error, the fallback is to store only the child's PID (`u32`) in managed state and use `child.kill()` within the same async task that spawned it (via a `tokio::sync::oneshot` channel to signal cancellation from `cancel_command`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/environment.rs src-tauri/src/lib.rs
git commit -m "feat: add run_python_command and cancel_command for subprocess management"
```

---

## Task 3: Add frontend command wrappers

Add TypeScript bindings for the new Rust commands.

**Files:**
- Modify: `src/platform/backend.ts` (add new functions)

- [ ] **Step 1: Add runPythonCommand wrapper**

In `src/platform/backend.ts`, add after the existing command wrappers:

```typescript
/**
 * Spawn a long-running command and stream stdout/stderr via Channel.
 * Returns true if the process exited successfully.
 */
export async function runPythonCommand(
  program: string,
  args: string[],
  onEvent: (event: ProcessEvent) => void
): Promise<boolean> {
  if (!isTauri) {
    console.warn("runPythonCommand is only available in Tauri");
    return false;
  }
  return streamingInvoke<boolean>("run_python_command", { program, args }, onEvent);
}
```

Note: `streamingInvoke` currently returns `Promise<void>` (line 97-106). It needs to be updated to return the command's return value. Update its signature:

```typescript
async function streamingInvoke<T = void>(
  cmd: string,
  args: Record<string, unknown>,
  onEvent: (event: ProcessEvent) => void
): Promise<T> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<ProcessEvent>();
  channel.onmessage = onEvent;
  return invoke<T>(cmd, { ...args, onEvent: channel });
}
```

- [ ] **Step 2: Add cancelCommand wrapper**

```typescript
/**
 * Cancel the currently running subprocess.
 */
export async function cancelCommand(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("cancel_command");
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 4: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/platform/backend.ts
git commit -m "feat: add runPythonCommand and cancelCommand frontend bindings"
```

---

## Task 4: Labels merge function

The core merge logic. This is the most complex piece and is fully testable in isolation.

**Files:**
- Create: `src/lib/merge.ts`
- Create: `tests/unit/merge.test.ts`

- [ ] **Step 1: Write tests for skeleton matching**

Create `tests/unit/merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";
import { merge } from "@/lib/merge";

function makeSkeleton(nodeNames: string[], name?: string): Skeleton {
  return new Skeleton({ nodes: nodeNames, name });
}

function makeVideo(filename: string): Video {
  return new Video({ filename, openBackend: false });
}

describe("merge", () => {
  describe("skeleton matching", () => {
    it("maps matching skeletons by node names", () => {
      const skel1 = makeSkeleton(["A", "B", "C"]);
      const skel2 = makeSkeleton(["A", "B", "C"]);
      const video = makeVideo("test.mp4");

      const target = new Labels({
        skeletons: [skel1],
        videos: [video],
      });
      const source = new Labels({
        skeletons: [skel2],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[10, 20], [30, 40], [50, 60]], skel2, 0.9),
            ],
          }),
        ],
      });

      merge(target, source);

      // Prediction should use target's skeleton, not source's
      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances[0].skeleton).toBe(skel1);
    });

    it("adds unmatched skeletons to target", () => {
      const skel1 = makeSkeleton(["A", "B"]);
      const skel2 = makeSkeleton(["X", "Y", "Z"]);
      const video = makeVideo("test.mp4");

      const target = new Labels({ skeletons: [skel1], videos: [video] });
      const source = new Labels({
        skeletons: [skel2],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[1, 2], [3, 4], [5, 6]], skel2, 0.8),
            ],
          }),
        ],
      });

      merge(target, source);
      expect(target.skeletons).toHaveLength(2);
      expect(target.skeletons[1].nodeNames).toEqual(["X", "Y", "Z"]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run tests/unit/merge.test.ts 2>&1 | tail -20`
Expected: FAIL — `merge` not found (module doesn't exist yet).

- [ ] **Step 3: Write tests for video and track matching**

Add to `tests/unit/merge.test.ts`:

```typescript
  describe("video matching", () => {
    it("maps videos with matching basenames", () => {
      const skel = makeSkeleton(["A", "B"]);
      const vid1 = makeVideo("/path/a/video.mp4");
      const vid2 = makeVideo("/path/b/video.mp4");

      const target = new Labels({ skeletons: [skel], videos: [vid1] });
      const source = new Labels({
        skeletons: [skel],
        videos: [vid2],
        labeledFrames: [
          new LabeledFrame({
            video: vid2,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[1, 2], [3, 4]], skel, 0.9),
            ],
          }),
        ],
      });

      merge(target, source);

      // Frame should reference target's video, not source's
      const frame = target.find({ video: vid1, frameIdx: 0 });
      expect(frame).toHaveLength(1);
      expect(target.videos).toHaveLength(1);
    });

    it("adds unmatched videos to target", () => {
      const skel = makeSkeleton(["A", "B"]);
      const vid1 = makeVideo("video1.mp4");
      const vid2 = makeVideo("video2.mp4");

      const target = new Labels({ skeletons: [skel], videos: [vid1] });
      const source = new Labels({
        skeletons: [skel],
        videos: [vid2],
        labeledFrames: [
          new LabeledFrame({
            video: vid2,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[1, 2], [3, 4]], skel, 0.5),
            ],
          }),
        ],
      });

      merge(target, source);
      expect(target.videos).toHaveLength(2);
    });
  });

  describe("track matching", () => {
    it("maps tracks with matching names", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");
      const track1 = new Track("animal_0");
      const track2 = new Track("animal_0");

      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        tracks: [track1],
      });
      const pred = PredictedInstance.fromArray([[1, 2], [3, 4]], skel, 0.9);
      pred.track = track2;
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        tracks: [track2],
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [pred] }),
        ],
      });

      merge(target, source);

      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances[0].track).toBe(track1);
      expect(target.tracks).toHaveLength(1);
    });
  });
```

- [ ] **Step 4: Write tests for frame merging — auto strategy**

Add to `tests/unit/merge.test.ts`:

```typescript
  describe("frame merging — auto strategy", () => {
    it("adds predictions to empty frames", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      const target = new Labels({ skeletons: [skel], videos: [video] });
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 5,
            instances: [
              PredictedInstance.fromArray([[10, 20], [30, 40]], skel, 0.9),
              PredictedInstance.fromArray([[50, 60], [70, 80]], skel, 0.8),
            ],
          }),
        ],
      });

      const result = merge(target, source);

      expect(result.framesAdded).toBe(1);
      expect(result.instancesAdded).toBe(2);
      const frame = target.find({ frameIdx: 5 })[0];
      expect(frame.instances).toHaveLength(2);
    });

    it("keeps user instances when predictions overlap", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      // Target has a user instance at (10,20), (30,40)
      const userInst = Instance.fromArray([[10, 20], [30, 40]], skel);
      const targetFrame = new LabeledFrame({
        video,
        frameIdx: 0,
        instances: [userInst],
      });
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [targetFrame],
      });

      // Source has a prediction at nearly the same location
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[11, 21], [31, 41]], skel, 0.95),
            ],
          }),
        ],
      });

      const result = merge(target, source);

      // User instance kept, prediction skipped
      expect(result.conflicts).toBe(1);
      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances).toHaveLength(1);
      expect(frame.instances[0]).toBe(userInst);
    });

    it("replaces old predictions with new predictions at same location", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      const oldPred = PredictedInstance.fromArray([[10, 20], [30, 40]], skel, 0.5);
      const targetFrame = new LabeledFrame({
        video,
        frameIdx: 0,
        instances: [oldPred],
      });
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [targetFrame],
      });

      const newPred = PredictedInstance.fromArray([[11, 21], [31, 41]], skel, 0.9);
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [newPred] }),
        ],
      });

      const result = merge(target, source);

      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances).toHaveLength(1);
      // New prediction replaced old one
      expect((frame.instances[0] as PredictedInstance).score).toBe(0.9);
    });

    it("adds non-overlapping predictions alongside existing instances", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      const userInst = Instance.fromArray([[10, 20], [30, 40]], skel);
      const targetFrame = new LabeledFrame({
        video,
        frameIdx: 0,
        instances: [userInst],
      });
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [targetFrame],
      });

      // Prediction far away from user instance
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[200, 300], [400, 500]], skel, 0.85),
            ],
          }),
        ],
      });

      const result = merge(target, source);

      expect(result.instancesAdded).toBe(1);
      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances).toHaveLength(2);
    });

    it("keeps unmatched target predictions", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      // Target has existing prediction at (100, 200)
      const existingPred = PredictedInstance.fromArray(
        [[100, 200], [300, 400]],
        skel,
        0.7
      );
      const targetFrame = new LabeledFrame({
        video,
        frameIdx: 0,
        instances: [existingPred],
      });
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [targetFrame],
      });

      // Source adds prediction far from existing one
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[500, 600], [700, 800]], skel, 0.85),
            ],
          }),
        ],
      });

      const result = merge(target, source);

      const frame = target.find({ frameIdx: 0 })[0];
      // Both old and new predictions kept
      expect(frame.instances).toHaveLength(2);
    });
  });
```

- [ ] **Step 5: Write tests for replace_predictions strategy**

Add to `tests/unit/merge.test.ts`:

```typescript
  describe("frame merging — replace_predictions strategy", () => {
    it("replaces all predictions but keeps user instances", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      const userInst = Instance.fromArray([[10, 20], [30, 40]], skel);
      const oldPred = PredictedInstance.fromArray([[50, 60], [70, 80]], skel, 0.5);
      const targetFrame = new LabeledFrame({
        video,
        frameIdx: 0,
        instances: [userInst, oldPred],
      });
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [targetFrame],
      });

      const newPred = PredictedInstance.fromArray([[55, 65], [75, 85]], skel, 0.95);
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({ video, frameIdx: 0, instances: [newPred] }),
        ],
      });

      const result = merge(target, source, {
        frameStrategy: "replace_predictions",
      });

      const frame = target.find({ frameIdx: 0 })[0];
      expect(frame.instances).toHaveLength(2);
      // User instance kept
      expect(frame.instances[0]).toBe(userInst);
      // New prediction replaced old
      expect(frame.instances[1]).toBeInstanceOf(PredictedInstance);
      expect((frame.instances[1] as PredictedInstance).score).toBe(0.95);
    });
  });
```

- [ ] **Step 6: Write tests for MergeResult**

Add to `tests/unit/merge.test.ts`:

```typescript
  describe("MergeResult", () => {
    it("returns correct counts", () => {
      const skel = makeSkeleton(["A", "B"]);
      const video = makeVideo("test.mp4");

      // Target: 1 user instance on frame 0
      const target = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [Instance.fromArray([[10, 20], [30, 40]], skel)],
          }),
        ],
      });

      // Source: 1 overlapping prediction on frame 0, 2 predictions on new frame 5
      const source = new Labels({
        skeletons: [skel],
        videos: [video],
        labeledFrames: [
          new LabeledFrame({
            video,
            frameIdx: 0,
            instances: [
              PredictedInstance.fromArray([[11, 21], [31, 41]], skel, 0.9),
            ],
          }),
          new LabeledFrame({
            video,
            frameIdx: 5,
            instances: [
              PredictedInstance.fromArray([[100, 200], [300, 400]], skel, 0.8),
              PredictedInstance.fromArray([[500, 600], [700, 800]], skel, 0.7),
            ],
          }),
        ],
      });

      const result = merge(target, source);

      expect(result.framesAdded).toBe(1); // frame 5 is new
      expect(result.instancesAdded).toBe(2); // 2 on frame 5
      expect(result.instancesSkipped).toBe(1); // overlapping pred on frame 0
      expect(result.conflicts).toBe(1); // user vs pred conflict
    });
  });
```

- [ ] **Step 7: Implement the merge function**

Create `src/lib/merge.ts`:

```typescript
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Video,
  Skeleton,
  Track,
} from "@talmolab/sleap-io.js";

export interface MergeOptions {
  /** Strategy for merging instances on overlapping frames. Default: "auto" */
  frameStrategy?: "auto" | "replace_predictions";
  /** Max centroid distance (px) to consider two instances as matching. Default: 5 */
  instanceMatchThreshold?: number;
}

export interface MergeResult {
  /** Number of new frames added to target */
  framesAdded: number;
  /** Number of instances added to target */
  instancesAdded: number;
  /** Number of incoming instances skipped (conflicts or duplicates) */
  instancesSkipped: number;
  /** Number of conflicts (user label vs prediction overlap) */
  conflicts: number;
}

/**
 * Compute the centroid (mean of visible points) of an instance.
 * Returns null if no visible points.
 */
export function centroid(
  instance: Instance | PredictedInstance
): [number, number] | null {
  const visible = instance.points.filter(
    (p) => p.visible && !isNaN(p.xy[0]) && !isNaN(p.xy[1])
  );
  if (visible.length === 0) return null;
  const x = visible.reduce((s, p) => s + p.xy[0], 0) / visible.length;
  const y = visible.reduce((s, p) => s + p.xy[1], 0) / visible.length;
  return [x, y];
}

/**
 * Compute Euclidean distance between two instance centroids.
 * Returns Infinity if either centroid is null.
 */
export function centroidDistance(
  a: Instance | PredictedInstance,
  b: Instance | PredictedInstance
): number {
  const ca = centroid(a);
  const cb = centroid(b);
  if (!ca || !cb) return Infinity;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

/**
 * Find the best spatial match for an instance among candidates.
 * Returns the index of the best match, or -1 if no match within threshold.
 */
function findBestMatch(
  instance: Instance | PredictedInstance,
  candidates: Array<Instance | PredictedInstance>,
  threshold: number
): number {
  let bestIdx = -1;
  let bestDist = threshold;
  for (let i = 0; i < candidates.length; i++) {
    const dist = centroidDistance(instance, candidates[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Merge instances from source Labels into target Labels, modifying target in place.
 *
 * Algorithm (5 steps):
 * 1. Match skeletons by node names (Skeleton.matches())
 * 2. Match videos by basename (Video.matchesPath(other, false))
 * 3. Match tracks by name
 * 4. Merge frames using the selected strategy
 *
 * Designed for upstream to @talmolab/sleap-io.js.
 */
export function merge(
  target: Labels,
  source: Labels,
  options?: MergeOptions
): MergeResult {
  const frameStrategy = options?.frameStrategy ?? "auto";
  const threshold = options?.instanceMatchThreshold ?? 5.0;

  const result: MergeResult = {
    framesAdded: 0,
    instancesAdded: 0,
    instancesSkipped: 0,
    conflicts: 0,
  };

  // Step 1: Match skeletons
  const skeletonMap = new Map<Skeleton, Skeleton>();
  for (const srcSkel of source.skeletons) {
    const match = target.skeletons.find((tSkel) => tSkel.matches(srcSkel));
    if (match) {
      skeletonMap.set(srcSkel, match);
    } else {
      target.skeletons.push(srcSkel);
      skeletonMap.set(srcSkel, srcSkel);
    }
  }

  // Step 2: Match videos
  const videoMap = new Map<Video, Video>();
  for (const srcVid of source.videos) {
    const match = target.videos.find((tVid) =>
      tVid.matchesPath(srcVid, false)
    );
    if (match) {
      videoMap.set(srcVid, match);
    } else {
      target.videos.push(srcVid);
      videoMap.set(srcVid, srcVid);
    }
  }

  // Step 3: Match tracks
  const trackMap = new Map<Track, Track>();
  for (const srcTrack of source.tracks) {
    const match = target.tracks.find((t) => t.name === srcTrack.name);
    if (match) {
      trackMap.set(srcTrack, match);
    } else {
      target.tracks.push(srcTrack);
      trackMap.set(srcTrack, srcTrack);
    }
  }

  // Step 4: Merge frames
  for (const srcFrame of source.labeledFrames) {
    const mappedVideo = videoMap.get(srcFrame.video) ?? srcFrame.video;
    const matchingFrames = target.find({
      video: mappedVideo,
      frameIdx: srcFrame.frameIdx,
    });

    // Remap instance references
    const remappedInstances = srcFrame.instances.map((inst) =>
      remapInstance(inst, skeletonMap, trackMap)
    );

    if (matchingFrames.length === 0) {
      // No matching frame — create new one
      const newFrame = new LabeledFrame({
        video: mappedVideo,
        frameIdx: srcFrame.frameIdx,
        instances: remappedInstances,
      });
      target.append(newFrame);
      result.framesAdded++;
      result.instancesAdded += remappedInstances.length;
    } else {
      // Merge into existing frame
      const targetFrame = matchingFrames[0];
      const mergeFrameResult = mergeFrame(
        targetFrame,
        remappedInstances,
        frameStrategy,
        threshold
      );
      result.instancesAdded += mergeFrameResult.added;
      result.instancesSkipped += mergeFrameResult.skipped;
      result.conflicts += mergeFrameResult.conflicts;
    }
  }

  return result;
}

/**
 * Remap an instance's skeleton and track references using the provided maps.
 * Returns the instance with updated references (mutates in place).
 */
function remapInstance(
  instance: Instance | PredictedInstance,
  skeletonMap: Map<Skeleton, Skeleton>,
  trackMap: Map<Track, Track>
): Instance | PredictedInstance {
  const mappedSkeleton = skeletonMap.get(instance.skeleton);
  if (mappedSkeleton && mappedSkeleton !== instance.skeleton) {
    instance.skeleton = mappedSkeleton;
  }
  if (instance.track) {
    const mappedTrack = trackMap.get(instance.track);
    if (mappedTrack) {
      instance.track = mappedTrack;
    }
  }
  return instance;
}

interface FrameMergeResult {
  added: number;
  skipped: number;
  conflicts: number;
}

/**
 * Merge incoming instances into a target frame using the specified strategy.
 */
function mergeFrame(
  targetFrame: LabeledFrame,
  incomingInstances: Array<Instance | PredictedInstance>,
  strategy: "auto" | "replace_predictions",
  threshold: number
): FrameMergeResult {
  if (strategy === "replace_predictions") {
    return mergeFrameReplacePredictions(targetFrame, incomingInstances);
  }
  return mergeFrameAuto(targetFrame, incomingInstances, threshold);
}

function mergeFrameReplacePredictions(
  targetFrame: LabeledFrame,
  incomingInstances: Array<Instance | PredictedInstance>
): FrameMergeResult {
  const userInstances = targetFrame.userInstances;
  const incomingPredictions = incomingInstances.filter(
    (i) => i instanceof PredictedInstance
  );
  targetFrame.instances = [...userInstances, ...incomingPredictions];
  return {
    added: incomingPredictions.length,
    skipped: incomingInstances.length - incomingPredictions.length,
    conflicts: 0,
  };
}

function mergeFrameAuto(
  targetFrame: LabeledFrame,
  incomingInstances: Array<Instance | PredictedInstance>,
  threshold: number
): FrameMergeResult {
  const result: FrameMergeResult = { added: 0, skipped: 0, conflicts: 0 };

  // Start with all user instances from target
  const merged: Array<Instance | PredictedInstance> = [
    ...targetFrame.userInstances,
  ];

  // Track which target instances have been matched
  const matchedTargetIndices = new Set<number>();

  for (const incoming of incomingInstances) {
    const matchIdx = findBestMatch(
      incoming,
      targetFrame.instances,
      threshold
    );

    if (matchIdx === -1) {
      // No match — add incoming
      merged.push(incoming);
      result.added++;
    } else {
      matchedTargetIndices.add(matchIdx);
      const matchedTarget = targetFrame.instances[matchIdx];

      if (matchedTarget instanceof PredictedInstance) {
        if (incoming instanceof PredictedInstance) {
          // Both predictions — replace with incoming (newer)
          merged.push(incoming);
          result.added++;
        } else {
          // Target prediction, incoming user — add user instance
          merged.push(incoming);
          result.added++;
        }
      } else {
        // Target is user instance — user label wins
        result.skipped++;
        result.conflicts++;
      }
    }
  }

  // Add unmatched target predictions
  for (let i = 0; i < targetFrame.instances.length; i++) {
    if (!matchedTargetIndices.has(i)) {
      const inst = targetFrame.instances[i];
      if (inst instanceof PredictedInstance) {
        merged.push(inst);
      }
    }
  }

  targetFrame.instances = merged;
  return result;
}
```

- [ ] **Step 8: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run tests/unit/merge.test.ts 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 9: Fix any test failures and iterate**

If any tests fail, read the error messages, fix the implementation, and re-run. The most likely issues:
- `Skeleton.matches()` may compare node order — check if source and target skeletons with same nodes in different order match
- `Video.matchesPath(other, false)` may not exist or have different semantics — check the actual API
- `PredictedInstance` constructor or `fromArray` may require different arguments
- `Labels.find()` may need both video and frameIdx to work correctly

- [ ] **Step 10: Commit**

```bash
git add src/lib/merge.ts tests/unit/merge.test.ts
git commit -m "feat: add Labels merge function with auto and replace_predictions strategies"
```

---

## Task 5: Inference store

Zustand store for managing inference state, progress, and UI.

**Files:**
- Create: `src/stores/inferenceStore.ts`
- Create: `tests/unit/inferenceStore.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/unit/inferenceStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useInferenceStore } from "@/stores/inferenceStore";

function resetStore() {
  useInferenceStore.setState(useInferenceStore.getInitialState());
}

describe("inferenceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts in idle state", () => {
    const state = useInferenceStore.getState();
    expect(state.status).toBe("idle");
    expect(state.progress).toBeNull();
    expect(state.log).toEqual([]);
    expect(state.minimized).toBe(false);
    expect(state.error).toBeNull();
  });

  it("updates progress from stdout JSON", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stdout",
      data: {
        line: '{"n_processed": 50, "n_total": 1000, "rate": 12.5, "eta": 76.0}',
      },
    });

    const state = useInferenceStore.getState();
    expect(state.progress).toEqual({
      nProcessed: 50,
      nTotal: 1000,
      rate: 12.5,
      eta: 76.0,
    });
  });

  it("appends non-JSON stdout to log", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stdout",
      data: { line: "Loading model..." },
    });

    const state = useInferenceStore.getState();
    expect(state.log).toEqual(["Loading model..."]);
    expect(state.progress).toBeNull();
  });

  it("appends stderr to log", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    handleProcessEvent({
      event: "stderr",
      data: { line: "WARNING: something" },
    });

    expect(useInferenceStore.getState().log).toEqual(["WARNING: something"]);
  });

  it("sets completed on successful finish", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    useInferenceStore.setState({ status: "running" });

    handleProcessEvent({
      event: "finished",
      data: { success: true, code: 0 },
    });

    expect(useInferenceStore.getState().status).toBe("completed");
  });

  it("sets error on failed finish", () => {
    const { handleProcessEvent } = useInferenceStore.getState();
    useInferenceStore.setState({ status: "running" });

    handleProcessEvent({
      event: "finished",
      data: { success: false, code: 1 },
    });

    const state = useInferenceStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("exit code 1");
  });

  it("toggles minimized state", () => {
    const { setMinimized } = useInferenceStore.getState();
    setMinimized(true);
    expect(useInferenceStore.getState().minimized).toBe(true);
    setMinimized(false);
    expect(useInferenceStore.getState().minimized).toBe(false);
  });

  it("resets to initial state", () => {
    useInferenceStore.setState({
      status: "completed",
      progress: { nProcessed: 100, nTotal: 100, rate: 10, eta: 0 },
      log: ["line1", "line2"],
      minimized: true,
    });

    useInferenceStore.getState().reset();
    const state = useInferenceStore.getState();
    expect(state.status).toBe("idle");
    expect(state.progress).toBeNull();
    expect(state.log).toEqual([]);
    expect(state.minimized).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run tests/unit/inferenceStore.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `src/stores/inferenceStore.ts`:

```typescript
import { create } from "zustand";
import type { ProcessEvent } from "@/platform/backend";

export interface InferenceProgress {
  nProcessed: number;
  nTotal: number;
  rate: number;
  eta: number;
}

export interface InferenceConfig {
  modelPath: string;
  videoIndex: number | "all";
  frameRange: "all" | "labeled" | { start: number; end: number };
  trackingMethod: "simple" | "flow" | "identity";
  maxInstances: number;
}

export type InferenceStatus =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

interface InferenceState {
  status: InferenceStatus;
  error: string | null;
  progress: InferenceProgress | null;
  log: string[];
  minimized: boolean;
  outputPath: string | null;

  handleProcessEvent: (event: ProcessEvent) => void;
  setMinimized: (minimized: boolean) => void;
  reset: () => void;
}

const initialState = {
  status: "idle" as InferenceStatus,
  error: null as string | null,
  progress: null as InferenceProgress | null,
  log: [] as string[],
  minimized: false,
  outputPath: null as string | null,
};

export const useInferenceStore = create<InferenceState>()((set) => ({
  ...initialState,

  handleProcessEvent: (event: ProcessEvent) => {
    switch (event.event) {
      case "stdout": {
        // Try parsing as JSON progress
        try {
          const data = JSON.parse(event.data.line);
          if (
            "n_processed" in data &&
            "n_total" in data
          ) {
            set({
              progress: {
                nProcessed: data.n_processed,
                nTotal: data.n_total,
                rate: data.rate ?? 0,
                eta: data.eta ?? 0,
              },
            });
            return;
          }
        } catch {
          // Not JSON — fall through to log
        }
        set((state) => ({ log: [...state.log, event.data.line] }));
        break;
      }
      case "stderr":
        set((state) => ({ log: [...state.log, event.data.line] }));
        break;
      case "finished":
        if (event.data.success) {
          set({ status: "completed" });
        } else {
          set({
            status: "error",
            error: `Process failed with exit code ${event.data.code}`,
          });
        }
        break;
    }
  },

  setMinimized: (minimized: boolean) => set({ minimized }),

  reset: () => set({ ...initialState }),
}));
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run tests/unit/inferenceStore.test.ts 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stores/inferenceStore.ts tests/unit/inferenceStore.test.ts
git commit -m "feat: add inferenceStore for managing inference state and progress"
```

---

## Task 6: MergePredictionsCommand

Add the undoable command that wraps the merge function.

**Files:**
- Modify: `src/commands/editCommands.ts`

- [ ] **Step 1: Add the command**

In `src/commands/editCommands.ts`, add imports at top:

```typescript
import { merge } from "@/lib/merge";
import { toast } from "@/lib/notify";
import type { Labels } from "@talmolab/sleap-io.js";
```

Add the command after the existing `DeleteAllPredictions` command (after line 347):

```typescript
/**
 * Merge predictions from inference output into current labels.
 * Supports "auto" (default) and "replace_predictions" strategies.
 */
export const MergePredictions: Command = {
  name: "MergePredictions",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    if (!labels) return;

    const predictions = params?.predictions as Labels;
    if (!predictions) return;

    const strategy =
      (params?.strategy as "auto" | "replace_predictions") ?? "auto";

    const snapshot = ctx.takeAllFramesSnapshot("MergePredictions");
    const result = merge(labels, predictions, { frameStrategy: strategy });
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    toast.success(
      `Merged ${result.instancesAdded} prediction(s). ${result.framesAdded} new frame(s), ${result.conflicts} conflict(s).`
    );
  },
};
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 3: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/editCommands.ts
git commit -m "feat: add MergePredictions undoable command"
```

---

## Task 7: InferenceMonitor component

Progress dialog with minimize-to-bar functionality.

**Files:**
- Create: `src/components/monitors/InferenceMonitor.tsx`
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Create InferenceMonitor**

Create `src/components/monitors/InferenceMonitor.tsx`:

```tsx
import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Minimize2,
  Maximize2,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { useInferenceStore } from "@/stores/inferenceStore";

function formatEta(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-green-400" />;
    case "error":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "cancelled":
      return <AlertCircle className="h-4 w-4 text-yellow-400" />;
    default:
      return null;
  }
}

/** Full dialog view of the inference monitor. */
function InferenceProgressDialog() {
  const { status, progress, log, error, minimized, setMinimized, reset } =
    useInferenceStore();
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;
  const isActive = status === "running" || status === "completed" || status === "error" || status === "cancelled";

  return (
    <Dialog
      open={isActive && !minimized}
      onOpenChange={(open) => {
        if (!open) {
          if (status === "running") {
            setMinimized(true);
          } else {
            reset();
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusIcon status={status} />
            {status === "running" && "Running Inference"}
            {status === "completed" && "Inference Complete"}
            {status === "error" && "Inference Failed"}
            {status === "cancelled" && "Inference Cancelled"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Progress bar */}
          {progress && (
            <div className="space-y-2">
              <Progress value={pct} className="h-2" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress.nProcessed} / {progress.nTotal} frames
                </span>
                <span>
                  {progress.rate.toFixed(1)} fps — ETA: {formatEta(progress.eta)}
                </span>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Log output */}
          {log.length > 0 && (
            <div
              ref={logRef}
              className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
            >
              {log.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            {status === "running" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMinimized(true)}
                >
                  <Minimize2 className="mr-1 h-3 w-3" />
                  Minimize
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => useInferenceStore.getState().cancelInference()}
                >
                  <X className="mr-1 h-3 w-3" />
                  Cancel
                </Button>
              </>
            )}
            {(status === "completed" ||
              status === "error" ||
              status === "cancelled") && (
              <Button variant="outline" size="sm" onClick={reset}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact bar shown when the monitor is minimized. */
function InferenceCompactBar() {
  const { status, progress, minimized, setMinimized } = useInferenceStore();

  if (status !== "running" || !minimized) return null;

  const pct =
    progress && progress.nTotal > 0
      ? (progress.nProcessed / progress.nTotal) * 100
      : 0;

  return (
    <div
      className="flex cursor-pointer items-center gap-3 border-t bg-muted/50 px-4 py-1.5 text-xs"
      onClick={() => setMinimized(false)}
    >
      <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
      <div className="flex-1">
        <Progress value={pct} className="h-1.5" />
      </div>
      <span className="text-muted-foreground">
        Inference: {progress?.nProcessed ?? 0}/{progress?.nTotal ?? 0} frames
        {progress ? ` (${progress.rate.toFixed(1)} fps)` : ""}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        onClick={(e) => {
          e.stopPropagation();
          setMinimized(false);
        }}
      >
        <Maximize2 className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        onClick={(e) => {
          e.stopPropagation();
          useInferenceStore.getState().cancelInference();
        }}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

/** Renders both the full dialog and the compact bar. Only one is visible at a time. */
export function InferenceMonitor() {
  return (
    <>
      <InferenceProgressDialog />
      <InferenceCompactBar />
    </>
  );
}
```

- [ ] **Step 2: Add cancelInference to the store**

In `src/stores/inferenceStore.ts`, add the `cancelInference` action. Add import:

```typescript
import { cancelCommand } from "@/platform/backend";
```

Add to the store:

```typescript
  cancelInference: async () => {
    await cancelCommand();
    set({ status: "cancelled" });
  },
```

And add it to the `InferenceState` interface:

```typescript
  cancelInference: () => Promise<void>;
```

- [ ] **Step 3: Add InferenceMonitor to AppShell**

In `src/components/layout/AppShell.tsx`, add import:

```typescript
import { InferenceMonitor } from "@/components/monitors/InferenceMonitor";
```

Add `<InferenceMonitor />` just **before** `<StatusBar />` in the layout JSX (not after the other dialogs). The dialog part renders via portal so its position doesn't matter, but the compact bar renders inline and needs to appear between the main content and the StatusBar:

```tsx
<InferenceMonitor />
<StatusBar />
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/monitors/InferenceMonitor.tsx src/stores/inferenceStore.ts src/components/layout/AppShell.tsx
git commit -m "feat: add InferenceMonitor with dialog and compact bar views"
```

---

## Task 8: Wire up InferenceDialog

Upgrade the placeholder InferenceDialog to submit real inference jobs.

**Files:**
- Modify: `src/components/dialogs/InferenceDialog.tsx`
- Modify: `src/stores/inferenceStore.ts` (add startInference action)
- Modify: `src/platform/backend.ts` (add runInference orchestration)

- [ ] **Step 1: Add runInference orchestration to backend.ts**

In `src/platform/backend.ts`, add:

```typescript
import type { InferenceConfig } from "@/stores/inferenceStore";

/**
 * Run sleap-nn inference. Orchestrates the full pipeline:
 * 1. Write labels to temp file
 * 2. Build CLI args
 * 3. Spawn process with streaming
 * 4. Return output path on success
 */
export async function runInference(
  config: InferenceConfig,
  labels: Labels,
  onEvent: (event: ProcessEvent) => void
): Promise<string | null> {
  if (!isTauri) {
    console.warn("Inference is only available in Tauri desktop mode");
    return null;
  }

  // Determine program and args based on how sleap-nn was found
  // For now, assume uv tool installation: program = "sleap-nn"
  const program = "sleap-nn";
  const args = ["track", "--gui"];

  // Add model path
  args.push("--model_paths", config.modelPath);

  // TODO: Write labels to temp .slp, add --data_path
  // TODO: Add --output_path for deterministic output location
  // TODO: Add video index, frame range, tracking method, max instances

  const success = await runPythonCommand(program, args, onEvent);
  if (!success) return null;

  // TODO: Return the output .slp path
  return null;
}
```

Note: The full temp-file orchestration (writing labels to .slp, reading output .slp) depends on sleap-io.js serialization capabilities and Tauri temp directory APIs. The above is the skeleton — the TODOs will be filled in when the file I/O integration is tested end-to-end with a real sleap-nn installation.

- [ ] **Step 2: Add startInference action to inferenceStore**

In `src/stores/inferenceStore.ts`, add import:

```typescript
import { runInference } from "@/platform/backend";
import { useAppStore } from "@/stores/appStore";
```

Add to the store (and the interface):

```typescript
  startInference: async (config: InferenceConfig) => {
    const labels = useAppStore.getState().labels;
    if (!labels) return;

    set({
      status: "running",
      error: null,
      progress: null,
      log: [],
      minimized: false,
    });

    const { handleProcessEvent } = useInferenceStore.getState();
    const outputPath = await runInference(config, labels, handleProcessEvent);

    // If completed successfully and we have an output path,
    // the InferenceMonitor will handle loading and merging results
    if (outputPath) {
      set({ outputPath });
    }
  },
```

Add to interface:

```typescript
  startInference: (config: InferenceConfig) => Promise<void>;
```

- [ ] **Step 3: Update InferenceDialog**

Rewrite `src/components/dialogs/InferenceDialog.tsx` to wire up the form to the real backend. Key changes:

1. Remove the "Coming Soon" badge
2. Add model directory picker (uses Tauri dialog for folder selection)
3. Wire "Run Inference" button to `inferenceStore.startInference(config)`
4. Disable button when no sleap-nn detected or inference already running
5. Show environment warning if sleap-nn not available

Keep the existing self-managing pattern (dialog reads `open` state from `useAppStore` internally, matching how `TrainingDialog` and other dialogs work). Do NOT change the component signature to accept props — that would break `AppShell.tsx` and `MenuBar.tsx` callsites.

```tsx
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, FolderOpen } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useInferenceStore } from "@/stores/inferenceStore";
import type { InferenceConfig } from "@/stores/inferenceStore";

type FrameRange = "all" | "labeled" | "custom";
type TrackingMethod = "simple" | "flow" | "identity";

export function InferenceDialog() {
  const open = useAppStore((s) => s.inferenceDialogOpen);
  const setOpen = useAppStore((s) => s.setInferenceDialogOpen);
  const labels = useAppStore((s) => s.labels);
  const videos = labels?.videos ?? [];
  const pythonCheck = useEnvironmentStore((s) => s.pythonCheck);
  const inferenceStatus = useInferenceStore((s) => s.status);

  const [modelPath, setModelPath] = useState("");
  const [selectedVideo, setSelectedVideo] = useState<string>("all");
  const [frameRange, setFrameRange] = useState<FrameRange>("all");
  const [frameStart, setFrameStart] = useState("0");
  const [frameEnd, setFrameEnd] = useState("100");
  const [trackingMethod, setTrackingMethod] =
    useState<TrackingMethod>("simple");
  const [maxInstances, setMaxInstances] = useState("10");

  const hasSleapNn = !!pythonCheck?.sleapNnVersion;
  const canRun =
    hasSleapNn && modelPath.length > 0 && inferenceStatus !== "running";

  const handleBrowseModel = async () => {
    // Use Tauri dialog directly for directory selection
    // (platform abstraction doesn't support directory mode yet)
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({ directory: true, title: "Select Model Directory" });
      if (selected) {
        setModelPath(selected as string);
      }
    } catch {
      // User cancelled or not in Tauri
    }
  };

  const handleRunInference = async () => {
    const config: InferenceConfig = {
      modelPath,
      videoIndex: selectedVideo === "all" ? "all" : parseInt(selectedVideo, 10),
      frameRange:
        frameRange === "custom"
          ? { start: parseInt(frameStart, 10), end: parseInt(frameEnd, 10) }
          : frameRange,
      trackingMethod,
      maxInstances: parseInt(maxInstances, 10),
    };

    setOpen(false);
    await useInferenceStore.getState().startInference(config);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run Inference</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!hasSleapNn && (
            <div className="flex items-start gap-2 rounded-md bg-yellow-500/10 p-3 text-sm text-yellow-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                sleap-nn not detected. Open the Environment panel to configure
                Python.
              </span>
            </div>
          )}

          {/* Model selection */}
          <div className="space-y-2">
            <Label>Model Directory</Label>
            <div className="flex gap-2">
              <Input
                value={modelPath}
                onChange={(e) => setModelPath(e.target.value)}
                placeholder="Path to trained model directory..."
                className="flex-1"
              />
              <Button variant="outline" size="icon" onClick={handleBrowseModel}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Video selection */}
          <div className="space-y-2">
            <Label>Video</Label>
            <Select value={selectedVideo} onValueChange={setSelectedVideo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All videos</SelectItem>
                {videos.map((v, i) => (
                  <SelectItem key={i} value={i.toString()}>
                    {typeof v.filename === "string"
                      ? v.filename.split("/").pop()
                      : `Video ${i}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Frame range */}
          <div className="space-y-2">
            <Label>Frame Range</Label>
            <Select
              value={frameRange}
              onValueChange={(v) => setFrameRange(v as FrameRange)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All frames</SelectItem>
                <SelectItem value="labeled">Labeled frames only</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {frameRange === "custom" && (
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={frameStart}
                  onChange={(e) => setFrameStart(e.target.value)}
                  placeholder="Start"
                  min={0}
                />
                <Input
                  type="number"
                  value={frameEnd}
                  onChange={(e) => setFrameEnd(e.target.value)}
                  placeholder="End"
                  min={0}
                />
              </div>
            )}
          </div>

          {/* Tracking method */}
          <div className="space-y-2">
            <Label>Tracking</Label>
            <Select
              value={trackingMethod}
              onValueChange={(v) => setTrackingMethod(v as TrackingMethod)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Simple</SelectItem>
                <SelectItem value="flow">Optical Flow</SelectItem>
                <SelectItem value="identity">Identity</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Max instances */}
          <div className="space-y-2">
            <Label>Max Instances</Label>
            <Input
              type="number"
              value={maxInstances}
              onChange={(e) => setMaxInstances(e.target.value)}
              min={1}
              max={100}
            />
          </div>

          {/* Run button */}
          <div className="flex justify-end">
            <Button onClick={handleRunInference} disabled={!canRun}>
              Run Inference
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 5: Run tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run 2>&1 | tail -20`
Expected: All tests pass (any dialog-related tests may need import updates).

- [ ] **Step 6: Commit**

```bash
git add src/components/dialogs/InferenceDialog.tsx src/stores/inferenceStore.ts src/platform/backend.ts
git commit -m "feat: wire up InferenceDialog to real backend with model selection and progress"
```

---

## Task 9: Integration and cleanup

Final wiring — ensure all pieces work together, handle edge cases.

**Files:**
- Modify: `src/components/monitors/InferenceMonitor.tsx` (add result loading + merge trigger)
- Modify: `src/stores/inferenceStore.ts` (add result loading)

- [ ] **Step 1: Add result loading and merge triggering to the monitor**

When inference completes successfully, the monitor should offer to load and merge results. Update `InferenceDialog` (the full dialog view inside InferenceMonitor) to show a "Load Results" button on completion that triggers the merge command.

In `src/components/monitors/InferenceMonitor.tsx`, update the completed state to include result loading. This will depend on having a `loadAndMergeResults` action in the inference store.

In `src/stores/inferenceStore.ts`, add:

```typescript
import { Labels } from "@talmolab/sleap-io.js";
import { loadSlp } from "@/lib/loadProject"; // or however .slp loading works

  loadAndMergeResults: async (commandContext: CommandContext) => {
    const { outputPath } = useInferenceStore.getState();
    if (!outputPath) return;

    try {
      // Load the output .slp file
      const platform = getPlatform();
      const data = await platform.readFile(outputPath);
      const predictions = await Labels.fromSlp(data);

      // Execute merge command
      await commandContext.execute(MergePredictions, { predictions });

      set({ status: "idle" });
    } catch (e) {
      set({
        status: "error",
        error: `Failed to load results: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
```

Note: The exact `.slp` loading API depends on how `sleap-io.js` exposes it. Check the existing `loadProject.ts` or similar for the pattern used to load `.slp` files. This may need adjustment.

- [ ] **Step 2: Verify full build**

Run: `cd /Users/talmo/code/sleap-label-web && npm run build 2>&1 | tail -20`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Run all tests**

Run: `cd /Users/talmo/code/sleap-label-web && npx vitest run 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 4: Manual smoke test**

If a Tauri dev environment is available:

Run: `cd /Users/talmo/code/sleap-label-web && npm run tauri dev`

Test:
1. Open the app, load a project
2. Open Inference dialog (should show form, no "Coming Soon")
3. Without sleap-nn installed: should show yellow warning
4. If sleap-nn is installed: browse to a model directory, configure options, click "Run Inference"
5. Progress dialog should appear with progress bar
6. Click "Minimize" — compact bar should appear at bottom
7. Click compact bar — dialog should re-open
8. On completion — results should merge into the project

- [ ] **Step 5: Final commit**

```bash
git add src/components/monitors/InferenceMonitor.tsx src/stores/inferenceStore.ts
git commit -m "feat: complete inference pipeline integration with result loading and merging"
```
