# Labeling Instances

An **instance** is one animal's pose on one frame: a position (and a
visible/not-visible flag) for each node in the project's
[skeleton](skeletons.md).

## Adding an instance

| How | What it does |
|---|---|
| ++cmd+i++ / ++ctrl+i++ | Add an instance using the current placement method |
| **Labels ▸ Add Instance** | Same, from the menu |
| Right-click ▸ **Add Instance** | Pick the placement method for this one instance |
| ++cmd++-drag an existing instance | Clone it, pose and all |

### Placement methods

**Labels ▸ Instance Placement Method** decides the starting pose of a new
instance. Getting this right saves a lot of dragging.

| Method | Starting pose |
|---|---|
| **Best** | Centered template, offset to avoid overlapping existing instances *(default)* |
| **Template** | The skeleton's stored template pose, unmodified |
| **Force Directed** | Centered, then iteratively pushed away from existing instances |
| **Random** | Random node positions |
| **Copy Prior Frame** | The pose from the previous labeled frame |
| **Copy Predictions** | The predicted instance already on this frame |

Once you have a model, **Copy Predictions** turns labeling into correction.

## Editing

- **Drag a node** to move it.
- **Drag the instance body** to move the whole pose.
- **Right-click** a node or instance for its context menu — visibility, deletion,
  track assignment, and more.
- **Node placement mode** (++n++, or **View ▸ Node Placement Mode**) is for
  clicking nodes down one at a time rather than dragging a pre-posed template.

### Visibility

Nodes that are genuinely occluded should be marked **not visible** rather than
parked somewhere plausible — a guessed point is training signal that says the
part is *there*, which it isn't.

- ++v++ toggles whether non-visible nodes are drawn at all.
- **View ▸ Display** controls how much of the hidden geometry you see:

    | Mode | Shows |
    |---|---|
    | **Manual** | Whatever you toggled by hand |
    | **Only selected (with hidden points)** | Just the selected instance, hidden points included |
    | **All instances, visible points only** | Every instance, visible points only |
    | **All visible + selected hidden points** | Everything, plus the selected instance's hidden points |

## Selecting

| Action | Shortcut |
|---|---|
| Select next instance | ++grave-accent++ |
| Select next / previous instance and zoom to it | ++shift+down++ / ++shift+up++ |
| Clear selection | ++escape++ |

Clicking an instance on the canvas selects it; the **Instances** panel lists the
current frame's instances with their track, type, and score.

## Copy and paste

| Action | Shortcut |
|---|---|
| Copy instance | ++cmd+c++ / ++ctrl+c++ |
| Paste instance | ++cmd+v++ / ++ctrl+v++ |
| Copy instance **track** | ++cmd+shift+c++ / ++ctrl+shift+c++ |
| Paste instance **track** | ++cmd+shift+v++ / ++ctrl+shift+v++ |

Copying a *track* copies the identity assignment rather than the pose — see
[Tracks](tracks.md).

## Deleting

| Action | Shortcut |
|---|---|
| Delete selected instance | ++cmd+backspace++ / ++ctrl+backspace++ |
| Delete instance **and** its track | ++cmd+shift+backspace++ / ++ctrl+shift+backspace++ |
| Delete predictions in a dragged area | ++cmd+k++ / ++ctrl+k++ |

**Labels ▸ Delete Predictions…** deletes in bulk — on the current frame, over a
frame range, or across the whole project.

## Working with predictions

Predicted instances are drawn distinctly from user labels (**View ▸ Color
Predicted Instances** changes how). They are suggestions until you accept them.

| Action | How |
|---|---|
| Accept one prediction | Double-click it |
| Accept all on this frame | ++cmd+shift+a++ / ++ctrl+shift+a++, or **Labels ▸ Accept All Predictions on Current Frame** |
| Accept all in the project | **Labels ▸ Accept All Predictions** |

Accepting converts a `PredictedInstance` into a user-labeled `Instance` — which
is what training actually consumes.

## Negative frames

**Labels ▸ Mark Frame as Negative** records that a frame genuinely contains no
animals. This is real training signal, not an empty frame that you skipped, and
the [label quality check](label-qc.md) will flag a negative frame that still has
instances on it.

## Undo

Every edit goes through a command with a frame-level snapshot, so ++cmd+z++ /
++ctrl+z++ and ++cmd+shift+z++ / ++ctrl+shift+z++ work across the whole editing
surface — not just node drags.

## Hints

**Labels ▸ Show Hints During Labeling** puts contextual tips on screen as you
work. **Help ▸ Labeling Tips…** opens the full list any time.
