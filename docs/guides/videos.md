# Videos

## Adding videos

| How | Where |
|---|---|
| Drag and drop onto the window | Anywhere |
| The video dropzone in **New Project** | New projects |
| The dropzone in the **Videos** panel — drag files onto it, or click it to browse | Open projects |
| **File ▸ Add Video from URL…** | Videos served over `https://` |

Both dropzones list the picked files with a **Grayscale** checkbox per file
(and **All grayscale** / **All RGB** for several at once). From the **Videos**
panel this list appears in an **Import Videos** dialog. Choose before you click
**Import** or **Create Project** — it can't be changed afterwards.

### Supported formats

| Extension | Opened with |
|---|---|
| `.mp4` | `mp4box.js` |
| `.webm`, `.mkv`, `.mov`, `.ogg`, `.ogv`, `.ts` | MediaBunny |
| `.avi`, `.wmv`, `.mpeg`, `.mpg` | web-demuxer |
| `.seq` | the app's SEQ reader |

The container only gets the file open; the codec inside it still has to be one
the app can decode — see [Codecs](#codecs).

`.pkg.slp` projects carry their frames inside the file, so they open with no
video files needed at all.

## Playback

Video decoding uses [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API).
The file is demuxed by `mp4box.js` (MP4), MediaBunny (WebM, MKV, MOV, Ogg,
MPEG-TS), or web-demuxer (AVI, WMV, MPEG), which gives frame-accurate seeking
rather than the approximate seeking you get from an HTML `<video>` element.
Playback speed runs from 0.25× to 8×.

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

## Checking a video's frames

Some videos play fine but don't **seek** reliably: jumping straight to frame N
shows a different image than playing up to it. Common causes are videos from
acquisition software, files with B-frames (frames stored out of order), and
variable frame rates. The result is labels that look shifted from the animal,
or that end up on the wrong image.

When a video opens, the app runs a quick check from what it already knows about
the file. If something looks off, the video gets a ⚠ in the **Videos** panel
("May not show every frame correctly").

For a full check, select the video and click **Check Frames…** in the
**Videos** panel. It reads every frame in order, then jumps straight to 20
frames and checks each one shows the same image. Long videos can take a few
minutes. The result says how many frames read, and lists any that couldn't be
read or that showed a different image when jumped to.

If the check finds problems, re-encode the video:

- **In the app** (desktop, and browsers that can encode the video): pick a
  quality (**High**, **Medium** or **Low**) and re-encode. The app writes a
  clean copy next to the original (`<name>.reencoded.mp4`) and offers to
  switch the project to it.
- **Otherwise** the dialog gives an ffmpeg command to run yourself, then use
  **Replace Video**. It looks like this:

    ```bash
    ffmpeg -i "input.avi" -c:v libx264 -crf 25 -preset superfast -g 30 -bf 0 \
      -pix_fmt yuv420p -fps_mode passthrough "input.reencoded.mp4"
    ```

    | Part | Why |
    |---|---|
    | `-c:v libx264` | H.264, which every reader decodes |
    | `-crf 25` | Quality: 18 is high, 25 medium, 32 low. Lower is better and bigger |
    | `-preset superfast` | Fast to encode |
    | `-g 30` | A keyframe every second (30 at 30 fps), so jumping to a frame is quick |
    | `-bf 0` | No B-frames, so frames are stored in order and seek exactly |
    | `-pix_fmt yuv420p` | 8-bit color, which [WebCodecs](#codecs) needs |
    | `-fps_mode passthrough` | Keeps every frame and its timing as-is |

Check and re-encode before you label if you can. Labels are attached to frame
numbers, so if the re-encoded copy has a different number of frames and the
video already has labels, the app won't switch to it (the labels would land on
the wrong images). The project keeps using the original.

## When videos move

A `.slp` project stores paths to its videos. Move the videos, or open the project
on another machine, and those paths stop resolving.

- **File ▸ Replace Videos… ▸ *(video name)***, or **Replace Video** in the
  **Videos** panel, re-points one video at a new file.
- **Locate All Missing** in the **Videos** panel (shown only when videos are
  missing) finds them all at once. In Chrome / Edge you pick one folder and the
  app matches each missing video by file name anywhere inside it; elsewhere you
  pick the files.
- The app also looks for the file near the project and next to the old path
  before asking you.

For remote jobs there is a dedicated **path resolution** dialog that maps every
file the job needs onto a path the worker can see — including auto-detecting the
rest of a folder and cascade-filling once it works out the prefix difference. See
[Remote Compute](remote-compute.md).

## Removing videos

The **Videos** panel lists the project's videos; **Remove Video** removes the
selected one. Removing a video removes its labeled frames with it, so if it has
any, the app confirms first.

## Exporting a labeled clip

**File ▸ Export ▸ Labeled Clip (Video)…** renders a video with the pose overlay
burned in — for talks, for figures, or for showing a collaborator what the data
actually looks like. You choose the frame range, which videos to include, and the
display settings, with a live preview before rendering.
