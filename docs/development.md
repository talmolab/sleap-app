# Development

Contributing to the app itself. For using it, start with the
[guides](guides/overview.md).

## Stack

| Layer | Technology |
|---|---|
| **UI** | React 19, TypeScript 5.7, Vite 6, Tailwind CSS v4 |
| **Components** | [shadcn/ui](https://ui.shadcn.com/) (Radix primitives) |
| **State** | [Zustand](https://zustand.docs.pmnd.rs/) + [Immer](https://immerjs.github.io/immer/) |
| **Rendering** | Canvas 2D — video frame layer + skeleton overlay layer |
| **Data model** | [@talmolab/sleap-io.js](https://iojs.sleap.ai) — SLP/HDF5 via [h5wasm](https://github.com/usnistgov/h5wasm) |
| **Video** | [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) + [mp4box.js](https://gpac.github.io/mp4box.js/) |
| **Desktop** | [Tauri v2](https://v2.tauri.app/) |
| **Shortcuts** | [tinykeys](https://github.com/jamiebuilds/tinykeys) |
| **Testing** | `bun test` (unit), [Playwright](https://playwright.dev/) (E2E) |

[bun](https://bun.com) is the package manager and runtime — there is no npm/Node
step.

## Commands

```bash
bun install

bun run dev          # browser dev server, port 5173
bun run build        # type check + production build
bun run lint         # ESLint
bun run test         # unit tests (bun's runner, --isolate)
bun run test:e2e     # Playwright E2E

bun run tauri:dev    # desktop dev mode
bun run tauri:build  # desktop installer
```

!!! warning "Always use `bun run test`"

    The suite runs with `--isolate`. A bare `bun test` without it currently
    panics bun 1.3.14.

### Linux system dependencies for Tauri

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf \
  libglib2.0-dev libayatana-appindicator3-dev libdbus-1-dev
```

## Layout

```
src/
├── main.tsx                     # entry, exposes window.sleap debug API
├── stores/                      # Zustand stores
├── commands/                    # command pattern with undo/redo
├── canvas/SkeletonRenderer.ts   # Canvas 2D overlay + hit testing
├── components/
│   ├── layout/                  #   AppShell, MenuBar, StatusBar, WelcomeScreen
│   ├── video/                   #   VideoPlayer, Seekbar, ContextMenu
│   ├── panels/                  #   Videos, Skeleton, Instances, Training, ...
│   ├── dialogs/                 #   GoToFrame, Training, Inference, Analyze, ...
│   ├── monitors/                #   loss plots, log terminal, visualizations
│   └── ui/                      #   shadcn/ui (generated -- do not hand-edit)
├── hooks/
├── lib/
│   ├── analyze/                 #   instance size + label QC
│   ├── transcode/               #   legacy-codec conversion (desktop)
│   ├── metrics/                 #   model metrics
│   └── ...
├── platform/                    # Tauri vs browser I/O abstraction
└── types/

src-tauri/                       # Tauri v2 desktop shell (Rust)
tests/
├── unit/                        # bun tests
├── e2e/                         # Playwright
└── fixtures/                    # SLP files
```

`@/` is aliased to `./src/`.

## Key patterns

- **Two-canvas rendering** — the video frame and the skeleton overlay are
  separate canvases, updated independently.
- **Command pattern** — every edit goes through `CommandContext` with a
  frame-level snapshot, which is what makes undo/redo uniform across the app.
- **`overlayVersion` counter** — bumped to force overlay re-renders when mutable
  data changes without a React state change.
- **Platform abstraction** — `src/platform/` isolates file I/O so the same code
  runs in Tauri and the browser.
- **Pure cores** — analysis and statistics logic lives in `*Core.ts` modules that
  touch no sleap-io objects, so it is unit-testable and worker-safe.

## sleap-io.js

The data model comes from `@talmolab/sleap-io.js`. For developing against
unpublished changes, clone it alongside this repo and link it:

```bash
bun add file:../sleap-io.js
```

Vite auto-detects whether `node_modules/@talmolab/sleap-io.js` is a local link or
a normal install. CI always uses the published package.

## Driving the desktop GUI

Playwright cannot drive the Tauri build — it runs in the OS WebView, not
Chromium. [`tauri-pilot`](https://github.com/mpiton/tauri-pilot) can:

```bash
cargo install tauri-pilot-cli   # once per machine

bun run tauri:dev
tauri-pilot ping
tauri-pilot snapshot -i         # interactive elements with @refs
tauri-pilot click '@e3'
tauri-pilot screenshot shot.png
tauri-pilot logs --level error
```

The plugin is a no-op in release builds, so it never ships.

## Contributing

`main` is protected — work on a branch, open a PR, and squash merge. Run
`bun run lint`, `bun run test`, and `bun run build` before you push.

## Docs

This site is built with [Zensical](https://zensical.org/) from `docs/`:

```bash
uvx --from zensical zensical serve   # live preview
uvx --from zensical zensical build   # static output in site/
```

`docs/internal/` holds engineering notes and is excluded from the published site.
