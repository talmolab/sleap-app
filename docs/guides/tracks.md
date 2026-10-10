# Tracks

A **track** is an identity that persists across frames — "this is the same mouse
as the one in the previous frame." Poses without tracks tell you *what* was
there; tracks tell you *who*.

## Assigning tracks

| Action | How |
|---|---|
| Create a new track | ++cmd+0++ / ++ctrl+0++, or **Tracks ▸ New Track** |
| Assign the selected instance to a track | **Tracks ▸ Set Instance Track ▸ …**, or right-click ▸ **Assign Track** |
| Assign the selected instance to track 1–9 | ++cmd+1++ … ++cmd+9++ / ++ctrl+1++ … ++ctrl+9++ |
| Copy an instance's track | ++cmd+shift+c++ / ++ctrl+shift+c++ |
| Paste a track onto an instance | ++cmd+shift+v++ / ++ctrl+shift+v++ |

++cmd+1++ … ++cmd+9++ (++ctrl+1++ … ++ctrl+9++) picks the track by its number in
the tracks legend. If that track doesn't exist yet, the app creates `Track 1`,
`Track 2`, … up to that number first, so you can start tracking with no setup.

Copy/paste of tracks is the fast way to fix a run of frames: copy the correct
identity once, then step forward pasting it onto the instance that should carry it.

### Renaming and recoloring

In the **Instances** panel:

- **Double-click a track name** to rename it inline. ++enter++ saves, ++escape++
  cancels.
- **Click the color swatch** next to it to pick that track's color — a palette
  preset or **Custom** — or **Reset to auto**.

## Transposing

++cmd+t++ / ++ctrl+t++ (**Tracks ▸ Transpose Instance Tracks**) swaps the track
assignment of two instances. This is *the* correction for the most common
tracking failure: two animals cross paths and the tracker swaps their identities.

On a frame with exactly two instances it swaps them directly. With three or
more, it asks you to pick the two.

## Propagating

**Tracks ▸ Propagate Track Labels** is a toggle. While it's on, changing an
instance's track (or transposing two instances) also swaps the identities on
every later frame — to the end of the video, or to the end of the frame range
selected on the seekbar. You fix a swap once rather than per frame.

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
- Hold ++ctrl++ to show the **tracks legend** on the canvas: each track's
  number, color, and name. The numbers are the ones ++cmd+1++ … ++cmd+9++ use.
  It only shows while ++ctrl++ is held (++ctrl++ on macOS too).
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
