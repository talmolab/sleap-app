# Navigation

## Moving between frames

| Action | Shortcut |
|---|---|
| Next / previous frame | ++right++ / ++left++ |
| ± 10 frames | ++cmd+right++ / ++cmd+left++ |
| ± 100 frames | ++cmd+shift+right++ / ++cmd+shift+left++ |
| First / last frame | ++home++ / ++end++ |
| Go to Frame… | ++cmd+j++ / ++ctrl+j++ |
| Select to Frame… | ++cmd+shift+j++ / ++ctrl+shift+j++ |

## Jumping to frames that matter

Scrubbing frame by frame through a 30-minute video is not a workflow. These jump
straight to the frames you care about:

| Target | Shortcut |
|---|---|
| Next / previous **labeled** frame | ++alt+right++ / ++alt+left++ |
| Next / previous **user-labeled** frame | ++cmd+u++ / ++cmd+shift+u++ |
| Next / previous **suggestion** | ++space++ / ++shift+space++ |
| Next **track spawn** frame | ++cmd+e++ / ++ctrl+e++ |
| Last interacted frame | ++cmd+a++ / ++ctrl+a++ |

"User-labeled" excludes frames that only carry predictions — useful when you want
to review your own work rather than a model's.

"Track spawn" frames are where a new track identity first appears, which is where
tracking errors usually originate.

### Navigation scope

**Go ▸ Navigate…** restricts what ++right++ / ++left++ step through:

- **All Frames** — every frame in the video
- **Labeled Frames Only** — skip everything unlabeled
- **Imaged Frames Only** — only frames whose pixels are actually present (useful
  in `.pkg.slp` projects with a sparse set of embedded images)

### Marks

Drop a mark on the current frame with ++cmd+m++ / ++ctrl+m++ and come back to it
with ++cmd+shift+m++ / ++ctrl+shift+m++.

## The seekbar

The bar under the video is more than a scrubber:

- **Labeled-frame marks** show where work already exists
- **Track occupancy bars** show which identities are present when
- **Snap to labeled frame** while dragging
- **Playback speed** from 0.25× to 8×

### Statistic graphs

**Tracks ▸ Seekbar Header** plots a per-frame statistic behind the seekbar, so
you can *see* where a video gets hard:

| Graph | What it shows |
|---|---|
| **Instance Count** | How many instances are on each frame |
| **Point Displacement** | How far points moved from the previous frame |
| **Primary Point Displacement** | The same, for one chosen node |
| **Tracking Score** | Confidence of the track assignment |
| **Instance Score** | Model confidence per instance |
| **Point Score** | Model confidence per point |
| **Number of predicted points** | Predicted point count per frame |
| **Min Centroid Proximity** | How close together the closest two animals get |

Where several of these have a **reduction** (sum, mean, max, min), the app keeps
your choice when you switch graphs if the new graph supports it.

Spikes in point displacement and dips in min centroid proximity are where
tracking breaks — jump there and check.

## Multiple videos

Projects can hold many videos. The **Videos** panel lists them; switch with:

| Action | Shortcut |
|---|---|
| Next video | ++alt+shift+right++ |
| Previous video | ++alt+shift+left++ |

See [Videos](videos.md) for adding, replacing, and resolving them.
