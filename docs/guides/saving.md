# Saving & Recovery

## Saving

| Action | Shortcut |
|---|---|
| Save | ++cmd+s++ / ++ctrl+s++ |
| Save As… | ++cmd+shift+s++ / ++ctrl+shift+s++ |

What **Save** does depends on where you're running:

=== "Desktop"

    **Save** writes back to the project's path on disk, like any native app.
    **Save As…** opens a native file dialog.

    **File ▸ Reveal Project in File Manager** shows the file in Finder / Explorer
    / your file manager.

=== "Browser"

    If you opened the file through the file picker, the page holds a writable
    handle to it and **Save** writes back to that same file in place. If you
    opened it by drag-and-drop — which yields no handle — **Save** falls back to
    a Save-As prompt. **Save As…** always prompts.

    The browser will ask for permission the first time it writes.

!!! note "Large embedded packages"

    A `.pkg.slp` with a lot of embedded image data can exceed what fits in
    memory at once. The desktop app detects this and switches to a streaming
    writer that copies image blobs disk-to-disk rather than materializing the
    whole file, so size is not a wall. It is slower over a network share, so
    saving a very large package to a mounted drive takes a while.

## Crash recovery

The app keeps a **draft** of unsaved work in the background — a debounced,
imageless snapshot written a beat after you stop editing. No toast, no dialog, no
memory cost for pixels.

- **Browser** — drafts go to the origin private file system (OPFS). Every browser
  project gets one, because browser tabs die.
- **Desktop** — drafts go to an app-local data directory.

If the app stops with unsaved work, the next launch shows a **Restore unsaved
work?** card on the welcome screen listing the recoverable drafts. Recovery is
always something you click; it never pops up on its own and never fires twice.
Starting a new project or opening another one just leaves the draft alone.

!!! warning "A draft is a net, not a save"

    On the desktop, a draft write never marks the project clean — the file on
    disk is still stale until you press ++cmd+s++. Drafts protect you from
    crashes, not from forgetting to save.

## Unsaved-work guards

The app will not let you quietly lose labels:

- Closing the window or quitting with unsaved changes prompts first
- Leaving a skeleton edit half-finished prompts first
- The [installer](../installation.md) refuses to replace a running copy of the
  desktop app

## Where preferences live

**File ▸ Open Preferences Directory…** (desktop) opens the folder holding
settings, transcode cache, and drafts. **File ▸ Clear Video Transcode Cache…**
clears cached transcodes from there.
