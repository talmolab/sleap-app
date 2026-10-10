# Merging Projects

**File ▸ Merge into Project…** combines another `.slp` into the one you have open
— for pulling together work split across people, sessions, or machines.

## The preview

Click **Choose .slp…** and pick the file to merge in. Before anything changes,
the app matches the two projects and shows a preview: how many **Videos** and
**Tracks** match or are new, and whether the **Skeleton** matches. Nothing is
applied until you click **Merge**.

Videos are matched by **basename** and tracks by **name**, so two projects
labeling the same videos line up even if the files sit at different paths.

!!! warning "The skeletons must match"

    If the incoming file's skeleton differs from this project's, the preview
    shows **Skeleton ⚠ differs** and the merge is blocked. Open that file as
    its own project, or make the two skeletons match first.

## Conflicts

A **conflict** is when both projects have a user-labeled instance on the same
frame of the same video, close enough to be the same animal (within 5 pixels).
Predictions never count as conflicts. The app groups conflicts into clusters — a
base instance can clash with several incoming instances and vice versa, so
they're resolved as a unit rather than pairwise.

If there are no conflicts, the dialog says it's a clean merge and **Merge**
combines the two projects.

If there are, pick a **Global rule** for them:

| Rule | Resolution |
|---|---|
| **Keep both** *(default)* | Keep every instance from both sides |
| **Base wins** | Keep this project's instance, discard the incoming one |
| **Donor wins** | The incoming project's instance replaces this project's |

## Reviewing conflicts

For anything you don't want decided by the global rule, the conflict list
(sortable by **Frame**, **Track**, and distance, and filterable) lets you set
**Keep** per conflict: **Both**, **Base**, or **Donor**. Click a row to draw the
competing instances on the actual frame so you can see which is right. **Reset
choices** drops your per-row picks and goes back to the global rule.

This is worth doing when two people labeled the same frames — the disagreements
are exactly the frames where your labeling guidelines are ambiguous, and seeing
them is useful beyond the merge itself.

## After merging

The result toast summarizes what happened. The merge is a normal command, so
++cmd+z++ / ++ctrl+z++ undoes it.

Run [Label Quality Check](label-qc.md) afterwards — merges are a common source of
duplicate instances.
