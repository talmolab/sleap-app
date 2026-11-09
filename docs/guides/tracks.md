# Tracks

A **track** is an identity that persists across frames — "this is the same mouse
as the one in the previous frame." Poses without tracks tell you *what* was
there; tracks tell you *who*.

## Assigning tracks

| Action | How |
|---|---|
| Create a new track | ++cmd+0++ / ++ctrl+0++, or **Tracks ▸ New Track** |
| Assign the selected instance to a track | **Tracks ▸ Set Instance Track ▸ …**, or right-click the instance's body ▸ **Assign Track** (once the project has tracks) |
| Assign the selected instance to track 1–9 | ++cmd+1++ … ++cmd+9++ / ++ctrl+1++ … ++ctrl+9++ |
| Copy an instance's track | ++cmd+shift+c++ / ++ctrl+shift+c++ |
| Paste a track onto an instance | ++cmd+shift+v++ / ++ctrl+shift+v++ |

++cmd+1++ … ++cmd+9++ (++ctrl+1++ … ++ctrl+9++) picks the track by its position
in **Tracks ▸ Set Instance Track**, which lists each track with its shortcut. If
that track doesn't exist yet, the app creates `Track 1`,
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

With it off, a change applies to the current frame only.

## Common tracking mistakes

Automatic tracking makes two kinds of mistakes. Both get worse the longer they
go unfixed, because each frame's identities follow from the frame before.

### Swapped identities

Two animals trade tracks, usually where they cross or touch. From then on, each
track follows the wrong animal.

**Find them:** color by track (see [Seeing tracks](#seeing-tracks)) and watch
for an animal changing color. Three ways to get to the right frames quickly:

- **Where animals come close.** **Tracks ▸ Seekbar Header ▸ Min Centroid
  Proximity** plots the distance between the two nearest animals. Swaps happen
  at the dips.
- **Where something jumps.** A swap looks like a sudden jump in position. In
  the [Suggestions](suggestions.md) panel, generate **Velocity** suggestions
  on a stable node, such as the torso rather than a paw, then step through them
  with ++space++. A higher threshold gives fewer, more likely frames.
- **Where trails cross.** Set **View ▸ Trail Length** to about 50 and step
  through the video in big jumps (++cmd+right++ / ++ctrl+right++ moves 10
  frames). Trails that cross or tangle mark a swap.

With few animals, the **five+** palette (**View ▸ Color Palette**) makes later
tracks stand out; with many, **alphabet** gives each a distinct color.
**View ▸ Edge Style ▸ Wedge** shows which way each animal faces.

**Fix them:** turn on **Propagate Track Labels**, go to the first frame after
the swap, and press ++cmd+t++ / ++ctrl+t++ to transpose the two tracks back.

### Lost identities

The tracker loses an animal, often when it's hidden or not detected for a few
frames, and starts a **new track** when it reappears. One animal is now split
across two tracks, and the project has more tracks than animals.

**Find them:** ++cmd+e++ / ++ctrl+e++ jumps to the next frame where a track
first appears. A track starting partway through the video is usually a break,
not a new animal. The track bars on the seekbar show where one track ends and
another begins.

**Fix them:** turn on **Propagate Track Labels**, go to the frame where the new
track starts, and assign that instance to the original track (++cmd+1++ …
++cmd+9++ / ++ctrl+1++ … ++ctrl+9++, or **Tracks ▸ Set Instance Track**). The
new track is reassigned on every later frame, joining the two. Then run
**Delete Unused Tracks** to remove the leftover.

!!! tip "Fewer mistakes to begin with"

    Setting **Max tracks** to the number of animals when you run inference
    keeps the tracker from creating extra tracks. See
    [Inference](inference.md#tracking) for the tracker settings.

## Cleaning up

| Action | Effect |
|---|---|
| **Delete Instance and Track** (++cmd+shift+backspace++) | Removes the selected instance and every other instance on its track in the current video. The track stays in the project, and other videos are untouched. |
| **Delete Track ▸ …** | Removes one track from the project |
| **Delete Unused Tracks** | Removes tracks with no instances left on them |
| **Delete All Tracks** | Clears every track assignment |

**Delete Unused Tracks** is worth running before export — tracking passes tend to
leave behind empty identities that clutter the track list and every analysis file.

## Seeing tracks

- The **track occupancy bars** on the seekbar show which identities exist when,
  and where they start and stop.
- ++cmd+e++ / ++ctrl+e++ jumps to the next **track spawn** frame — where a new
  identity first appears. New identities mid-video are usually a tracking break
  rather than a new animal, so this is a fast audit route.
- **View ▸ Apply Distinct Colors To ▸ Tracks** colors instances by identity, which
  makes a swap visible instantly. Predictions are drawn yellow unless
  **View ▸ Color Predicted Instances** is on, so turn that on too when
  proofreading tracked predictions.
- **View ▸ Show Track Scores** displays the tracker's confidence.
- **Tracks ▸ Seekbar Header ▸ Tracking Score** (or **Min Centroid Proximity**)
  plots where tracking is likely to have gone wrong — see
  [Navigation](navigation.md).

## Trails

**View ▸ Trail Length** draws each instance's recent path behind it. A trail that
teleports across the frame is an identity swap; a trail that stops dead is a lost
track.
