# Browser vs Desktop

The same codebase runs in both. What differs is how it reaches the outside world:
files, processes, and GPUs.

| | Browser | Desktop |
|---|---|---|
| Install | None — [app.sleap.ai](https://app.sleap.ai) | ~5 MB, [installer](../installation.md) |
| Open / save `.slp` | File System Access API | Native file dialogs, writes in place |
| Drag-and-drop | ✅ | ✅ |
| Labeling, tracks, view, analyze | ✅ | ✅ |
| Video playback (WebCodecs) | ✅ | ✅ |
| Transcode legacy codecs | ❌ convert externally | ✅ native ffmpeg sidecar, cached |
| Local training / inference | ❌ | ✅ via [Environment](../guides/environment.md) |
| Remote training / inference | ✅ | ✅ |
| Crash-recovery drafts | ✅ OPFS | ✅ app data directory |
| Reveal file in file manager | ❌ | ✅ |
| In-app updates | Reload the page | ✅ per [channel](../installation.md#release-channels) |
| Offline | Only if cached | ✅ |

## Which should I use?

**Browser** if you are labeling, reviewing predictions, or checking someone
else's project — there is nothing to install and nothing to keep up to date. It
is also the right choice on a machine you don't administer, and it can still
train and predict through a [remote worker](../guides/remote-compute.md).

**Desktop** if you want native file handling on large projects, a local GPU, or
legacy-codec videos handled for you.

Projects are the same `.slp` files either way, so moving between them costs
nothing.

## Saving differences worth knowing

In the browser, opening a file through the picker gives the page a writable
handle and **Save** writes back to that same file. Opening by drag-and-drop
yields no handle, so **Save** falls back to a Save-As prompt. On the desktop,
**Save** always writes to the project's path.

See [Saving & Recovery](../guides/saving.md).

## Under the hood

The desktop app is [Tauri v2](https://v2.tauri.app/) — it uses the operating
system's own WebView rather than bundling a browser engine, which is why it is
~5 MB rather than ~244 MB. Platform-specific behavior is isolated behind a small
abstraction layer, so features arrive in both runtimes at once unless they
fundamentally cannot.
