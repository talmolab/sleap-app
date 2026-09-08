# Panels

Panels live in a column beside the video. Open them from the **Panels** menu.

**View ▸ Allow Multiple Panels** lets several be open at once; **View ▸ Sidebar on
Left** moves the column; **Panels ▸ Reset to Defaults…** restores the layout.

| Panel | What it's for |
|---|---|
| **Videos** | List, switch between, and remove the project's videos |
| **Skeleton** | Nodes, edges, and symmetries — [guide](../guides/skeletons.md) |
| **Instances** | The current frame's instances, with track, type, and score |
| **View** | Display settings, same as the View menu — [guide](../guides/view.md) |
| **Suggestions** | Generate and work through frames worth labeling — [guide](../guides/suggestions.md) |
| **Frames** | Every labeled frame in the project, with instance counts and prediction scores |
| **Training** | Configure and run sleap-nn training — [guide](../guides/training.md) |
| **Inference** | Configure and run predictions — [guide](../guides/inference.md) |
| **Environment** | Python toolchain setup via `uv` (desktop only) — [guide](../guides/environment.md) |
| **Connect** | Log in and connect to remote GPU workers — [guide](../guides/remote-compute.md) |
| **Notifications** | History of toasts and messages |
| **Debug** | Internal state, for bug reports |

## Frames panel

A compact, searchable table of every labeled frame — video, frame index, instance
counts, and prediction scores. It virtualizes its rows, so it stays responsive on
projects with tens of thousands of labeled frames. Click a row to go there.

Use it to audit coverage: which videos have labels, where they cluster, and which
frames only have predictions.

## Instances panel

The current frame's instances. Shows each one's track, whether it is a user label
or a prediction, and its score. Selecting a row selects the instance on the
canvas.

## Notifications panel

Toasts disappear; this doesn't. When something failed while you were looking
elsewhere — a transcode, a save, a remote job — the message is here.
++cmd+shift+d++ dismisses all active toasts.

## Debug panel

Internal application state. Not needed for normal use, but useful to screenshot
when reporting a bug. **Help ▸ Collect Diagnostics…** gathers more, in a file you
can attach directly.
