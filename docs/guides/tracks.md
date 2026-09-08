# Tracks

A **track** is an identity that persists across frames — "this is the same mouse
as the one in the previous frame." Poses without tracks tell you *what* was
there; tracks tell you *who*.

## Assigning tracks

| Action | How |
|---|---|
| Create a new track | ++cmd+0++ / ++ctrl+0++, or **Tracks ▸ New Track** |
| Assign the selected instance to a track | **Tracks ▸ Set Instance Track ▸ …** |
| Copy an instance's track | ++cmd+shift+c++ / ++ctrl+shift+c++ |
| Paste a track onto an instance | ++cmd+shift+v++ / ++ctrl+shift+v++ |

Copy/paste of tracks is the fast way to fix a run of frames: copy the correct
identity once, then step forward pasting it onto the instance that should carry it.

## Transposing

++cmd+t++ / ++ctrl+t++ (**Tracks ▸ Transpose Instance Tracks**) swaps the track
assignment of two instances. This is *the* correction for the most common
tracking failure: two animals cross paths and the tracker swaps their identities.

Trigger it and pick the two instances to swap.

## Propagating

**Tracks ▸ Propagate Track Labels** carries a track assignment forward across
frames, so you fix an identity once rather than per-frame.

## Cleaning up

| Action | Effect |
|---|---|
| **Delete Instance and Track** (++cmd+shift+backspace++) | Removes the instance and its track |
| **Delete Track ▸ …** | Removes one track from the project |
| **Delete Unused Tracks** | Removes tracks with no instances left on them |
| **Delete All Tracks** | Clears every track assignment |

**Delete Unused Tracks** is worth running before export — tracking passes tend to
leave behind empty identities that clutter the legend and every analysis file.

## Seeing tracks

- The **track occupancy bars** on the seekbar show which identities exist when,
  and where they start and stop.
- ++cmd+e++ / ++ctrl+e++ jumps to the next **track spawn** frame — where a new
  identity first appears. New identities mid-video are usually a tracking break
  rather than a new animal, so this is a fast audit route.
- The **tracks legend** on the canvas maps colors to identities.
- **View ▸ Apply Distinct Colors To ▸ Tracks** colors instances by identity, which
  makes a swap visible instantly.
- **View ▸ Show Track Scores** displays the tracker's confidence.
- **Tracks ▸ Seekbar Header ▸ Tracking Score** (or **Min Centroid Proximity**)
  plots where tracking is likely to have gone wrong — see
  [Navigation](navigation.md).

## Trails

**View ▸ Trail Length** draws each instance's recent path behind it. A trail that
teleports across the frame is an identity swap; a trail that stops dead is a lost
track.
