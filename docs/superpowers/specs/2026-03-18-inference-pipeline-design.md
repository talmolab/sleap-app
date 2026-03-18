# Phase 2: Inference Pipeline Design

## Overview

Connect the sleap-label-web frontend to `sleap-nn` for running inference on labeled datasets. The frontend drives orchestration; Rust provides a thin generic command runner.

**Approach:** Minimal Rust relay. The frontend builds CLI args, parses progress, reads output, and merges predictions. Rust spawns processes and streams stdout/stderr via Channel.

## Architecture

```
InferenceDialog (config form)
        │
        ▼
platform/backend.ts  runInference(config)
        │
        ├─ 1. Write current Labels to temp .slp file (platform FS)
        ├─ 2. Build CLI: sleap-nn track --gui --data_path <temp> --model_paths <dir> ...
        ├─ 3. invoke('run_python_command', {pythonPath, args, onEvent: channel})
        │         │
        │         ▼
        │    Rust: spawn python process, stream stdout/stderr/exit via Channel
        │         │
        │         ▼
        ├─ 4. Parse stdout JSON lines → inferenceStore progress updates
        ├─ 5. On completion: read output .slp via sleap-io.js
        └─ 6. merge(currentLabels, outputLabels) → MergePredictionsCommand (undoable)
```

## Components

### 1. Rust Backend — Generic command runner

Two new commands in `environment.rs` (or a new `commands.rs`):

**`run_python_command`**
- Params: `program: String`, `args: Vec<String>`, `on_event: Channel<ProcessEvent>`
- Spawns `program <args>` via shell plugin
- **Does NOT use `stream_command`** — needs its own spawn logic to retain the `CommandChild` handle for cancellation (the existing `stream_command` discards `_child`)
- Streams stdout/stderr/exit via Channel using a renamed `ProcessEvent` enum (was `InstallEvent`)
- Stores the `CommandChild` in managed state (`RunningProcess` behind a `Mutex`) for cancellation

**`cancel_command`**
- No params (cancels the single running process)
- Calls `.kill()` on the stored `CommandChild` handle
- Clears managed state

**Note on invocation:** If `sleap-nn` was installed as a uv tool, the program is `sleap-nn` (the tool binary), not `python -m sleap_nn`. If installed in a Python environment, the program is the Python interpreter with `-m sleap_nn` args. The frontend detects which mode based on how sleap-nn was found during environment detection.

**Capabilities:** No additional capabilities needed. The existing `shell:allow-open` plus Rust-side `ShellExt` spawning (via `app.shell().command()`) is sufficient — `shell:allow-spawn`/`shell:allow-kill` are only needed for frontend-side JS `Command` API, which we don't use.

No inference-specific Rust code. The same commands can be reused for training in Phase 3.

### 2. Inference Store (`src/stores/inferenceStore.ts`)

Zustand store, separate from appStore and environmentStore.

```typescript
interface InferenceState {
  // Status
  status: "idle" | "running" | "completed" | "error" | "cancelled";
  error: string | null;

  // Progress (parsed from stdout JSON lines)
  progress: {
    nProcessed: number;
    nTotal: number;
    rate: number; // FPS
    eta: number;  // seconds remaining
  } | null;

  // Log (stderr lines for debugging)
  log: string[];

  // UI
  minimized: boolean;

  // Actions
  startInference: (config: InferenceConfig) => Promise<void>;
  cancelInference: () => Promise<void>;
  reset: () => void;
  setMinimized: (minimized: boolean) => void;
}
```

### 3. Inference Orchestration (`src/platform/backend.ts`)

```typescript
interface InferenceConfig {
  modelPath: string;        // path to model directory (contains best.ckpt + training_config.yaml)
  videoIndex: number | "all";
  frameRange: "all" | "labeled" | { start: number; end: number };
  trackingMethod: "simple" | "flow" | "identity";
  maxInstances: number;
}
```

New function `runInference(config, onEvent)`:

1. Get environment info from environmentStore — determine if sleap-nn is a uv tool (use `sleap-nn` binary) or in a Python env (use `pythonPath -u -m sleap_nn`)
2. Validate sleap-nn is available
3. Write current Labels to a temp `.slp` file in the OS temp directory (via `tempDir()` from `@tauri-apps/api/path` + platform FS). Clean up on completion, cancellation, or error.
4. Construct output path: `<tempDir>/predictions_<timestamp>.slp`
5. Build CLI args array:
   ```
   ["track",
    "--gui",
    "--data_path", tempSlpPath,
    "--model_paths", config.modelPath,
    "--output_path", outputSlpPath,
    "--video_index", config.videoIndex,
    // ... frame range, tracking, max instances as needed
   ]
   ```
6. Call `invoke('run_python_command', { program, args, onEvent: channel })`
7. Channel callback:
   - Parse stdout lines as JSON (`{"n_processed", "n_total", "rate", "eta"}`) → update `inferenceStore.progress`
   - Non-JSON stdout lines and stderr lines → append to `inferenceStore.log`
   - On `Finished { success: true }`: trigger result loading from `outputSlpPath`
   - On `Finished { success: false }`: set error status, keep log visible

New function `loadInferenceResults(outputPath)`:
1. Read the output `.slp` file via platform FS
2. Parse with `sleap-io.js` to get a `Labels` object
3. Return the Labels for merging
4. Clean up temp files (input + output .slp)

### 4. InferenceDialog (upgrade existing)

Changes to `src/components/dialogs/InferenceDialog.tsx`:

- Remove "Coming Soon" badge
- **Model selection**: File picker button → user browses to a model directory (containing `best.ckpt` + `training_config.yaml`). Store path in local state.
- Existing fields (video, frame range, tracking, max instances) already collected — wire up
- **"Run Inference" button**:
  - Disabled when: no Python/sleap-nn detected, no model selected, inference already running
  - On click: calls `inferenceStore.startInference(config)`, closes dialog
- **Environment warning**: If no Python/sleap-nn, show inline alert with link to Environment panel
- Form validation: model path required, frame range valid

### 5. InferenceMonitor (new component)

`src/components/monitors/InferenceMonitor.tsx`

**Full dialog view** (when `minimized: false`):
- Dialog/modal with title "Running Inference"
- Progress bar: `nProcessed / nTotal` with percentage
- Stats line: "12.5 fps — ETA: 1m 16s"
- Expandable stderr log (monospace, auto-scroll, max-h-48, like InstallLog)
- Cancel button → `inferenceStore.cancelInference()`
- Minimize button → `inferenceStore.setMinimized(true)`
- On completion: shows summary ("Added N predictions across M frames"), dismiss button
- On error: shows error message, log stays visible

**Compact bar view** (when `minimized: true`):
- Rendered at the bottom of the app (above StatusBar or within it)
- Shows: progress bar + "Inference: 50/1000 frames (12.5 fps)" + expand button
- Click anywhere on bar → `setMinimized(false)` to re-open dialog
- Cancel button (small X icon)

Both views read from the same `inferenceStore` — just different presentations.

### 6. Prediction Merging (`src/lib/merge.ts`)

Standalone merge function designed for upstream to sleap-io.js.

#### API

```typescript
interface MergeOptions {
  frameStrategy?: "auto" | "replace_predictions";
  instanceMatchThreshold?: number; // default 5.0 (pixels)
}

interface MergeResult {
  framesAdded: number;
  instancesAdded: number;
  instancesSkipped: number;
  conflicts: number;
}

function merge(
  target: Labels,
  source: Labels,
  options?: MergeOptions
): MergeResult;
```

#### Algorithm

**Step 1: Match skeletons**
- For each skeleton in `source.skeletons`:
  - Find match in `target.skeletons` via `Skeleton.matches()` (compares node names)
  - If match found: add to `skeletonMap` (source → target)
  - If no match: add skeleton to `target.skeletons`, map to itself

**Step 2: Match videos**
- For each video in `source.videos`:
  - Find match in `target.videos` via `Video.matchesPath(other, false)` (basename comparison)
  - If match found: add to `videoMap`
  - If no match: add video to `target.videos`, map to itself

**Step 3: Match tracks**
- For each track in `source.tracks`:
  - Find match in `target.tracks` by `Track.name` equality
  - If match found: add to `trackMap`
  - If no match: add track to `target.tracks`, map to itself

**Step 4: Merge frames**

For each `LabeledFrame` in `source.labeledFrames`:
1. Remap video reference via `videoMap`
2. Find matching frame in target via `target.find({video, frameIdx})`
3. **If no matching frame:** Create new `LabeledFrame`, remap all instance references (skeleton, track), append via `target.append()`
4. **If matching frame exists:** Merge instances using frame strategy:

**`auto` strategy (default):**
```
For the matching target frame and incoming source frame:

1. Start with merged = [...targetFrame.userInstances]  (keep all user labels)
2. Track matchedTargetIndices = new Set<number>()

3. For each incoming instance:
   a. Find best spatial match in target frame (centroid distance < threshold)
   b. If matched to a user instance:
      → skip incoming (user label wins), count as conflict
      → add target index to matchedTargetIndices
   c. If matched to a target prediction:
      → replace with incoming (newer wins)
      → add target index to matchedTargetIndices
   d. If no match → add incoming to merged

4. For each target prediction NOT in matchedTargetIndices:
   → add to merged (keep existing unmatched predictions)

5. targetFrame.instances = merged
```

**`replace_predictions` strategy:**
```
1. Keep all user instances from target frame
2. Remove all existing predictions from target frame
3. Add all predictions from source frame
4. targetFrame.instances = [...userInstances, ...sourcePredictions]
```

**Instance remapping:** For each instance added from source:
- Replace `instance.skeleton` with `skeletonMap.get(instance.skeleton)`
- Replace `instance.track` with `trackMap.get(instance.track)` (if track exists)

**Spatial matching:** Compare instance centroids (mean of visible point coordinates). Two instances match if centroid distance ≤ `instanceMatchThreshold` (default 5px).

```typescript
function centroid(instance: Instance): [number, number] | null {
  const visible = instance.points.filter(p => p.visible && !isNaN(p.xy[0]));
  if (visible.length === 0) return null;
  const x = visible.reduce((s, p) => s + p.xy[0], 0) / visible.length;
  const y = visible.reduce((s, p) => s + p.xy[1], 0) / visible.length;
  return [x, y];
}

function centroidDistance(a: Instance, b: Instance): number {
  const ca = centroid(a), cb = centroid(b);
  if (!ca || !cb) return Infinity;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}
```

### 7. MergePredictionsCommand (`src/commands/editCommands.ts`)

Undoable command that wraps the merge function.

```typescript
export const MergePredictionsCommand: Command = {
  name: "MergePredictions",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  execute(ctx, params) {
    const { labels } = ctx.state;
    const predictions = params?.predictions as Labels;
    const strategy = params?.strategy as string ?? "auto";

    // Snapshot all frames for undo (merge can affect any frame)
    const snapshot = ctx.takeAllFramesSnapshot("MergePredictions");

    const result = merge(labels, predictions, { frameStrategy: strategy });

    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();
    toast.success(
      `Added ${result.instancesAdded} predictions across ${result.framesAdded} frames`
    );
  },
};
```

## Files to Create/Modify

### New files:
| File | Purpose |
|------|---------|
| `src/stores/inferenceStore.ts` | Zustand store for inference state |
| `src/lib/merge.ts` | Labels merge function (upstream candidate) |
| `src/components/monitors/InferenceMonitor.tsx` | Progress dialog + compact bar |

### Modified files:
| File | Change |
|------|--------|
| `src-tauri/src/environment.rs` (or new file) | Add `run_python_command` + `cancel_command`, rename `InstallEvent` → `ProcessEvent` |
| `src-tauri/src/lib.rs` | Register new commands + `RunningProcess` managed state |
| `src/platform/backend.ts` | Add `runInference()`, `loadInferenceResults()` |
| `src/components/dialogs/InferenceDialog.tsx` | Wire up to real backend |
| `src/commands/editCommands.ts` | Add `MergePredictionsCommand` |
| `src/components/layout/AppShell.tsx` | Render InferenceMonitor |

## Out of Scope

- ZMQ communication (Phase 3, training only)
- Config auto-generation via `sleap-nn config` (future enhancement)
- Model registry / browser (users pick directories manually)
- Remote inference (future)
- Web version support (desktop only, web shows "not available")
- Full sleap-io Python merge parity (subset, overlap, image dedup, provenance — not needed for inference use case)
