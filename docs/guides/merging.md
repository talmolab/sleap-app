# Merging Projects

**File ▸ Merge into Project…** combines another `.slp` into the one you have open
— for pulling together work split across people, sessions, or machines.

## The preview

Before anything changes, the app matches the two projects and shows you what the
merge would do: how many frames and instances are new, how many match, and how
many conflict. Nothing is applied until you accept it.

Videos are matched by **basename** and tracks by **name**, so two projects
labeling the same videos line up even if the files sit at different paths.

## Conflict strategies

A **conflict** is when both projects have instances on the same frame of the same
video, close enough to be the same animal (within a few pixels). The app groups
these into clusters — a base instance can clash with several donor instances and
vice versa, so they're resolved as a unit rather than pairwise.

| Strategy | Resolution |
|---|---|
| **Smart** | Prefer user labels over predictions, and the more complete instance otherwise |
| **Keep both** | Keep every instance from both sides |
| **New wins** | The incoming project's instance replaces the existing one |
| **Base wins** | Keep the existing instance, discard the incoming one |

**Smart** is the right default: it will not let a prediction overwrite a label
you placed by hand.

## Reviewing conflicts

For anything you don't want decided by a blanket rule, the **conflict review**
step walks you through clusters one at a time, drawing the competing instances on
the actual frame so you can see which is right, and lets you choose the survivors
per cluster.

This is worth doing when two people labeled the same frames — the disagreements
are exactly the frames where your labeling guidelines are ambiguous, and seeing
them is useful beyond the merge itself.

## After merging

The result toast summarizes what happened. The merge is a normal command, so
++cmd+z++ / ++ctrl+z++ undoes it.

Run [Label Quality Check](label-qc.md) afterwards — merges are a common source of
duplicate instances.
