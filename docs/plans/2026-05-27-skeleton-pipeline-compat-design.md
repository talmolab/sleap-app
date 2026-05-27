# Skeleton ↔ Pipeline Compatibility Warnings — Design

**Issue:** #100
**Branch:** `amick/skeleton-pipeline-compat`

## Goal

Surface warnings and disable incompatible model types in the Training panel based on the loaded skeleton's structure, preventing users from selecting pipelines that will fail or degrade at training time.

## Phase 1: Client-Side Validation

### Skeleton Analysis

A `getSkeletonCompatibility(skeleton)` function returns compatibility info. The skeleton hits exactly one case:

| Skeleton state | bottom_up / bottom_up_id | Other types | Message |
|---|---|---|---|
| 0 edges (includes 1-node) | **Disabled** | Enabled | "Bottom-Up requires skeleton edges for Part Affinity Fields" |
| Edges > 0, disconnected components | **Warning** (not disabled) | Enabled | "Bottom-Up works best with a fully connected skeleton" |
| Connected multi-node | Enabled | Enabled | (none) |

Connectivity check: BFS/union-find over `skeleton.edges`, ~15 lines.

Returns:
```typescript
interface SkeletonCompatibility {
  disabledTypes: Set<ModelType>;
  warnings: Map<ModelType, string>;
  recommendation: string | null;
}
```

### UI Changes (TrainingPanel.tsx)

1. **Subscribe to skeleton:** `const skeleton = useAppStore((s) => s.skeleton)`
2. **Compute compatibility** via `useMemo` from skeleton
3. **Disable SelectItem options** for incompatible model types with reason suffix, e.g., "Bottom-Up (requires edges)"
4. **Inline message** below the Select — `text-[10px] text-muted-foreground` for disabled types, amber-tinted for warnings
5. **Loaded incompatible config guard:** If the saved `config.modelType` is disabled, don't force-change it — show warning and disable Train button

### Train Button Guard

Add to existing `startDisabledReason` validation (~line 343):
- If `disabledTypes.has(config.modelType)`, disable Train with "Selected model type is incompatible with the current skeleton"

### Reactivity

Skeleton comes from `useAppStore`, compatibility is `useMemo` on it — editing the skeleton (add/remove nodes or edges) re-evaluates automatically.

## Phase 2: sleap-nn Recommender Integration (Deferred)

Full `recommend_pipeline()` integration via IPC/CLI. Requires `analyze_slp()` to compute `DatasetStats` (animal-to-frame ratio, instance counts, etc.). Enables:
- Animal-size-based pipeline recommendations
- Backbone, sigma, scale, batch size suggestions
- Camera-view-aware rotation defaults

## Not in Scope

- Auto-switching model type when skeleton changes
- Skeleton editing from the Training panel
- Backend-side validation (tracked in sleap-nn#567)
