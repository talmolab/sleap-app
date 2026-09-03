# Videos

## Adding videos

| How | Where |
|---|---|
| Drag and drop onto the window | Anywhere |
| The video dropzone in **New Project** | New projects |
| **File ▸ Add Video from URL…** | Videos served over `https://` |

`.pkg.slp` projects carry their frames inside the file, so they open with no
video files needed at all.

## Playback

Video decoding uses [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
with `mp4box.js` for demuxing, which gives frame-accurate seeking rather than
the approximate seeking you get from an HTML `<video>` element. Playback speed
runs from 0.25× to 8×.

## Codecs

WebCodecs decodes, at 8-bit:

- H.264, HEVC/H.265
- VP8, VP9
- AV1

MJPEG works too — the app decodes it as per-frame JPEGs.

Everything else needs converting first: MPEG-1/2, MPEG-4 ASP (Xvid/DivX),
MS-MPEG4, WMV 1–3, VC-1, and **10-bit H.264/HEVC**, which WebCodecs rejects even
though it handles the 8-bit form.

### Transcoding (desktop only)

When the desktop app opens a video in a codec it cannot decode, it offers to
transcode it to H.264 MP4 once and reuse the result thereafter.

The conversion runs disk-to-disk in a native ffmpeg sidecar process — the source
bytes never enter the app's memory — so a multi-gigabyte legacy file converts at
a flat, small memory cost. The result is cached, keyed on the source file, and
written atomically, so an interrupted transcode never leaves a half-file behind.

**File ▸ Clear Video Transcode Cache…** frees that space when you no longer need it.

!!! note "In the browser"

    There is no transcoding in the browser build. Convert the file first:

    ```bash
    ffmpeg -i input.avi -c:v libx264 -pix_fmt yuv420p output.mp4
    ```

    `-pix_fmt yuv420p` matters — it is what forces 8-bit output.

## When videos move

A `.slp` project stores paths to its videos. Move the videos, or open the project
on another machine, and those paths stop resolving.

- **File ▸ Replace Videos ▸ *(video name)*** re-points one video at a new file.
- The app also looks for the file near the project and next to the old path
  before asking you.

For remote jobs there is a dedicated **path resolution** dialog that maps every
file the job needs onto a path the worker can see — including auto-detecting the
rest of a folder and cascade-filling once it works out the prefix difference. See
[Remote Compute](remote-compute.md).

## Removing videos

The **Videos** panel lists the project's videos and lets you remove one. Removing
a video removes its labeled frames with it, so the app confirms first.

## Exporting a labeled clip

**File ▸ Export ▸ Labeled Clip (Video)…** renders a video with the pose overlay
burned in — for talks, for figures, or for showing a collaborator what the data
actually looks like. You choose the frame range, which videos to include, and the
display settings, with a live preview before rendering.
