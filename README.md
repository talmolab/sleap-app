# SLEAP App

Pose estimation and tracking app for [SLEAP](https://sleap.ai).

A modern rewrite of SLEAP's Qt/Python desktop labeling interface as a web app, with an optional [Tauri v2](https://v2.tauri.app/) desktop shell for native file access. Runs entirely in the browser -- no server or Python required.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **UI** | React 19, TypeScript 5.7, Vite 6, Tailwind CSS v4 |
| **Components** | [shadcn/ui](https://ui.shadcn.com/) (Radix primitives), black/orange theme |
| **State** | [Zustand](https://zustand.docs.pmnd.rs/) + [Immer](https://immerjs.github.io/immer/) |
| **Rendering** | Canvas 2D API (two-layer: video frame + skeleton overlay) |
| **Data model** | [@talmolab/sleap-io.js](https://github.com/talmolab/sleap-io.js) -- SLP/HDF5 via [h5wasm](https://github.com/usnistgov/h5wasm) |
| **Video** | [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) + [mp4box.js](https://gpac.github.io/mp4box.js/) |
| **Desktop** | Tauri v2 (~5 MB vs ~244 MB Electron) |
| **Shortcuts** | [tinykeys](https://github.com/jamiebuilds/tinykeys) (~400 B) |
| **Testing** | [bun test](https://bun.com/docs/cli/test) (200+ unit tests), [Playwright](https://playwright.dev/) (E2E) |

## Features

### File I/O
- Open `.slp` files via file picker or drag-and-drop (including `.pkg.slp` with embedded videos)
- Save / Save As in native SLP format (browser h5wasm writer)
- Export labels as JSON

### Video & Navigation
- MP4 playback via WebCodecs with frame-accurate seeking
- Seekbar with labeled frame marks, track occupancy bars, and snap-to-labeled-frame
- Playback speed control (0.25x -- 8x)
- Go to Frame dialog, next/prev labeled frame, next/prev suggestion

### Labeling & Editing
- Skeleton overlay with nodes (circles), edges (lines / wedges), and labels
- Click to select instances, drag nodes to reposition
- Add / delete instances and nodes
- Copy / paste instances and tracks
- Right-click context menu for instance and node actions
- Undo / redo with frame-level snapshots via the command pattern

### View Controls
- Zoom, pan, and fit-to-instances
- Show / hide: instances, node labels, edges, non-visible nodes
- Color-by mode: **Track**, **Instance**, **Node**, or **Edge** (View > Apply Distinct Colors To)
- Three color palettes: standard, five+, alphabet
- Edge style: Line or Wedge
- Configurable node marker size

### Panels
- **Videos** -- list and switch between project videos
- **Skeleton** -- view and edit skeleton nodes and edges
- **Instances** -- current frame's instances with track, type, score
- **Suggestions** -- suggested frames for labeling

### Keyboard Shortcuts

40+ shortcuts matching SLEAP's defaults:

| Action | Shortcut |
|--------|----------|
| Open / Save / Save As | `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Next / prev frame | `Right` / `Left` |
| Next / prev labeled frame | `Alt+Right` / `Alt+Left` |
| Next / prev suggestion | `Space` / `Shift+Space` |
| Go to frame | `Ctrl+J` |
| Add / delete instance | `Ctrl+I` / `Ctrl+Backspace` |
| Select next instance | `` ` `` |
| Fit view | `Ctrl+=` |
| Transpose tracks | `Ctrl+T` |
| New track | `Ctrl+0` |

## Development

```bash
# Install dependencies
bun install

# Start dev server (browser)
bun run dev          # http://localhost:5173

# Start Tauri dev mode (desktop, requires system deps)
bun run tauri:dev

# Run tests
bun run test         # unit tests (bun, --isolate)
bun run test:e2e     # Playwright E2E tests

# Production builds
bun run build        # Browser (dist/)
bun run tauri:build  # Desktop installer (.msi / .dmg / .deb)
```

### System Dependencies (Linux, for Tauri)

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf \
  libglib2.0-dev libayatana-appindicator3-dev libdbus-1-dev
```

### sleap-io.js Dependency

The data model and SLP file handling come from `@talmolab/sleap-io.js`. It can be used from a local checkout or from the npm registry.

**Local development (default)** -- links to a sibling checkout for developing against unpublished changes:

```bash
# Expects ../sleap-io.js to exist (git clone it alongside this repo)
bun add file:../sleap-io.js
```

`bun add` updates `package.json` + `bun.lock` and installs in one step (there is no
`bun pkg set` equivalent). Alternatively, hand-edit the
`dependencies."@talmolab/sleap-io.js"` field in `package.json` to `"file:../sleap-io.js"`,
then run `bun install`.

**Published package (CI / standalone)** -- uses the package from the npm registry:

```bash
bun add @talmolab/sleap-io.js@<version>
```

Or hand-edit the `dependencies."@talmolab/sleap-io.js"` version in `package.json`,
then run `bun install`.

The Vite config auto-detects which mode is active by checking whether `@talmolab/sleap-io.js` in `node_modules` is a local link (symlink to an out-of-tree checkout) rather than a normal install.

## Architecture

```
src/
├── main.tsx                     # Entry point, exposes window.sleap debug API
├── App.tsx                      # Root component
├── stores/appStore.ts           # Zustand store (selection, view, project state)
├── commands/                    # SLEAP-style command pattern with undo/redo
│   ├── CommandContext.ts        #   Executor with frame-level snapshots
│   ├── fileCommands.ts          #   New, Open, Save, SaveAs, ExportJson
│   ├── navCommands.ts           #   Frame/suggestion/video navigation
│   ├── editCommands.ts          #   Instance/node editing, copy/paste
│   └── trackCommands.ts         #   Track assignment, transpose, copy/paste
├── canvas/SkeletonRenderer.ts   # Canvas 2D overlay renderer + hit testing
├── components/
│   ├── layout/                  #   AppShell, MenuBar, StatusBar, WelcomeScreen
│   ├── video/                   #   VideoPlayer (two-canvas), Seekbar, ContextMenu
│   ├── panels/                  #   Videos, Skeleton, Instances, Suggestions
│   ├── dialogs/                 #   GoToFrame, Training, Inference
│   └── ui/                      #   shadcn/ui component library
├── hooks/                       #   useKeyboardShortcuts, useFileIO
├── lib/
│   ├── colorPalettes.ts         #   Palette definitions + color-by-mode logic
│   ├── loadProject.ts           #   Consolidated SLP loading pipeline
│   ├── saveProject.ts           #   Save SLP via upstream saveSlpToBytes
│   ├── resolveVideos.ts         #   Video backend resolution for .pkg.slp
│   └── shortcuts.ts             #   40+ keyboard shortcut definitions
├── platform/                    #   Tauri vs browser file I/O abstraction
└── types/                       #   TypeScript type definitions

src-tauri/                       # Tauri v2 desktop shell (Rust)
tests/                           # bun unit tests + Playwright E2E
```

### Key Patterns

- **Two-canvas rendering** -- video frame canvas + skeleton overlay canvas, independently updated for performance
- **Command pattern** -- every edit goes through `CommandContext` for undo/redo with frame-level snapshots
- **`overlayVersion` counter** -- bumped to force overlay re-renders when mutable data changes without React state changes
- **Reference equality** -- all `labeledFrame` lookups use `===` on video objects (avoids a basename-matching bug in sleap-io.js `Labels.find()`)
- **Platform abstraction** -- `src/platform/` abstracts file I/O so the same codebase runs in Tauri and the browser

## Deployment

Deployment is automated via GitHub Actions:

- **On merge to `main`** -- the browser app is built and deployed to the **dev** site at [https://app.sleap.ai/dev/](https://app.sleap.ai/dev/) (`.github/workflows/deploy.yml`, published to the `gh-pages` branch).
- **On GitHub Release** (published) -- the browser app is deployed to **production** at [https://app.sleap.ai](https://app.sleap.ai), and the Tauri desktop installers are built for all three platforms and attached to the release (`.github/workflows/build.yml`): Linux `.deb` / `.AppImage`, macOS `.dmg`, and Windows `.msi` / `.exe`, along with a `latest.json` auto-update manifest.

Both targets can also be run manually from the **Actions** tab (`deploy.yml` / `build.yml` `workflow_dispatch`).

## License

BSD-3-Clause. See [LICENSE](LICENSE).
