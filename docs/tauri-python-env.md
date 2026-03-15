# Tauri + Python Environment Management: Architecture Notes

Research compiled 2025-03-15. Focus: environment discovery, `uv` orchestration, process spawning with pipe passthrough — no PyO3 embedding, no HTTP sidecar.

---

## Table of Contents

1. [Key Building Blocks](#key-building-blocks)
2. [Microsoft PET (Python Environment Tool)](#microsoft-pet)
3. [uv CLI Integration](#uv-cli-integration)
4. [uv Bundling Strategy](#uv-bundling-strategy)
5. [Tauri Shell Plugin for Process Management](#tauri-shell-plugin)
6. [Environment Discovery Logic](#environment-discovery-logic)
7. [Conda Considerations](#conda-considerations)
8. [Spawning Python with the Right Env Vars](#spawning-python)
9. [Dev Mode / Escape Hatches](#dev-mode)
10. [Relevant Projects and Libraries](#relevant-projects)
11. [Proposed Architecture](#proposed-architecture)

---

## Key Building Blocks

| Component                            | Role                                             | Language      | Integration                               |
| ------------------------------------ | ------------------------------------------------ | ------------- | ----------------------------------------- |
| **PET** (`python-environment-tools`) | Environment discovery                            | Rust          | JSON-RPC server or embed as library crate |
| **uv** CLI                           | Env creation, Python install, package mgmt       | Rust (binary) | Shell out — no public Rust API            |
| **tauri-plugin-shell**               | Process spawning + stdin/stdout/stderr streaming | Rust + TS     | Built-in Tauri v2 plugin                  |
| **tauri-sidecar-manager**            | Sidecar lifecycle management                     | Rust          | Optional Tauri plugin                     |

There is **no turnkey "Tauri + uv + Python env manager" library**. You're writing glue code, but the hard parts (cross-platform discovery, fast package management, async process streaming) are solved by these components.

---

## Microsoft PET

**Repo**: https://github.com/microsoft/python-environment-tools  
**License**: MIT  
**Language**: Rust  

### What It Is

PET is a fast Rust-based environment scanner extracted from the VS Code Python extension. It powers environment discovery in VS Code's new Python Environments extension (GA as of Feb 2026). It runs as a JSON-RPC server (`pet server`) or as a CLI (`pet find`).

### Supported Environment Types

- python.org installs
- Windows Store Python
- pyenv / pyenv-win / pyenv-virtualenv
- Conda / Miniconda / Miniforge
- PipEnv
- Homebrew
- VirtualEnvWrapper / VirtualEnvWrapper-Win
- venv / virtualenv
- Python on PATH
- Global installs
- All virtual environments

### How It Works

- Scans PATH, known installation locations, and configurable search paths
- Collects all environment info at once to minimize I/O and avoid spawning Python processes
- Reports environments as structured data via JSON-RPC notifications
- Can be configured with workspace search paths and cache directories

### JSON-RPC Interface

PET runs as a long-lived server process communicating via JSON-RPC over stdin/stdout. Key operations:

- **`configure`** — set workspace paths, search paths, cache directory
- **`refresh`** — trigger full discovery scan (optionally scoped by `searchPaths` or `searchKind`)
- **`resolve`** — resolve a specific Python executable path to full environment info

### PET Environment Data Structure

From the Positron IDE integration, PET reports environments like:

```rust
PythonEnvironment {
    display_name: Option<String>,
    name: Option<String>,
    executable: Option<PathBuf>,     // e.g., "/Users/x/proj/.venv/bin/python"
    kind: Option<EnvironmentKind>,   // Venv, Conda, Pyenv, etc.
    version: Option<String>,         // e.g., "3.12.8"
    prefix: Option<PathBuf>,         // e.g., "/Users/x/proj/.venv"
    manager: Option<ManagerInfo>,
    project: Option<PathBuf>,
    arch: Option<Architecture>,
    symlinks: Option<Vec<PathBuf>>,  // all python symlinks in the env
}
```

### Integration Options for Tauri

1. **Bundle PET as a sidecar binary** — spawn via `tauri-plugin-shell`, communicate JSON-RPC over stdin/stdout. This is exactly how VS Code uses it.

2. **Use PET as a Rust library crate** — since PET is pure Rust with a workspace of crates (`pet-core`, `pet-conda`, `pet-venv`, `pet-pyenv`, etc.), you could potentially depend on the crates directly in your Tauri backend. This is tighter coupling but avoids the sidecar overhead. The crate structure is modular with individual locators per environment type.

3. **Port the discovery logic** — PET's approach is well-documented and the locators are independent. If you only need a subset (e.g., venv + conda + PATH + uv-managed), you could reimplement just those.

### Caveats

- PET is designed for VS Code consumption; the JSON-RPC API may evolve
- The CLA requirement for contributions could be a friction point
- PET doesn't currently discover uv-managed Python installations explicitly (it finds them via PATH since uv puts them there)

---

## uv CLI Integration

### No Public Rust API

The `uv` crate on crates.io is the CLI entry point. From lib.rs docs: "The Rust API exposed here is not considered public interface." The internal `uv-python` crate exists but is marked internal. **Shell out to the `uv` binary for all operations.**

This is fine because uv is extremely fast — cold operations are milliseconds, warm operations are sub-millisecond.

### Key Commands for Environment Management

```bash
# Discovery
uv python list                     # List all discovered/installed Pythons
uv python list --all-versions      # Include all patch versions
uv python find 3.12                # Find Python matching version spec
uv python dir                      # Show where uv stores managed Pythons

# Installation
uv python install 3.12             # Download and install a managed Python
uv python install 3.11 3.12 3.13   # Install multiple versions

# Environment Creation
uv venv                            # Create .venv using project's Python
uv venv --python 3.12              # Create .venv with specific version
uv venv myenv --python 3.11        # Create named venv

# Package Management
uv pip install -e .                # Editable install (dev mode)
uv pip install -r requirements.txt # From requirements
uv pip sync requirements.lock      # Sync to exact lockfile
uv pip list --format json          # List installed packages as JSON

# Project Management
uv sync                            # Sync project deps from pyproject.toml
uv run python script.py            # Run in project environment
uv lock                            # Generate/update lockfile
```

### JSON Output Status

- `uv pip list --format json` — **works** (matches pip's interface)
- `uv version --output-format json` — **works**
- `uv python list --format json` — **in progress** (PR #10448), may be merged by now
- General `--output-format json` — tracked in issue #411, being added incrementally

For commands without JSON output, you'll need to parse stdout. The output is generally stable and line-oriented.

### Python Discovery in uv

uv distinguishes between:
- **Managed installations**: Pythons that uv downloaded (stored in `~/.local/share/uv/python/` on Linux, `~/Library/Application Support/uv/python/` on macOS, `%LOCALAPPDATA%\uv\python\` on Windows)
- **System installations**: Everything else (pyenv, homebrew, system packages, etc.)

Discovery order:
1. Virtual environment from `VIRTUAL_ENV` env var
2. `.venv` in the project directory
3. `.python-version` file (walks up to parent dirs, then user config dir)
4. Managed installations (newest first)
5. System installations (first compatible, not necessarily newest)

The `--python-preference` flag controls priority:
- `managed` (default) — prefer uv-managed
- `system` — prefer system installs
- `only-managed` / `only-system` — restrict to one type

### uv Storage Locations

| Platform | Data Dir                            | Cache Dir                  |
| -------- | ----------------------------------- | -------------------------- |
| Linux    | `~/.local/share/uv/`                | `~/.cache/uv/`             |
| macOS    | `~/Library/Application Support/uv/` | `~/Library/Caches/uv/`     |
| Windows  | `%LOCALAPPDATA%\uv\`                | `%LOCALAPPDATA%\uv\cache\` |

Within data dir:
- `python/` — managed Python installations
- `tools/` — globally installed tools (like pipx)

---

## uv Bundling Strategy

### Binary Characteristics

- **Single static binary** with no dependencies (no Python, no Rust runtime needed)
- **Platforms**: Linux (x86_64, aarch64), macOS (x86_64, aarch64), Windows (x86_64)
- **Size**: Compressed tarballs on GitHub Releases are ~13-16 MB per platform; uncompressed binary is ~40-50 MB. This varies by release.
- **Distribution**: Pre-built binaries on every GitHub release, also available as PyPI wheels
- **Self-update**: `uv self update` when installed via standalone installer

### Bundling as Tauri Sidecar

The Tauri sidecar system requires binaries named with target triple suffixes:

```
src-tauri/binaries/
  uv-x86_64-unknown-linux-gnu
  uv-aarch64-unknown-linux-gnu
  uv-x86_64-apple-darwin
  uv-aarch64-apple-darwin
  uv-x86_64-pc-windows-msvc.exe
```

In `tauri.conf.json`:
```json
{
  "bundle": {
    "externalBin": ["binaries/uv"]
  }
}
```

### Build Script for Downloading uv

Create a build script that downloads the correct uv binary for each target during `tauri build`:

```javascript
// scripts/download-uv.js
const VERSION = "0.10.10";
const TARGETS = {
  "x86_64-unknown-linux-gnu": `uv-x86_64-unknown-linux-gnu.tar.gz`,
  "aarch64-unknown-linux-gnu": `uv-aarch64-unknown-linux-gnu.tar.gz`,
  "x86_64-apple-darwin": `uv-x86_64-apple-darwin.tar.gz`,
  "aarch64-apple-darwin": `uv-aarch64-apple-darwin.tar.gz`,
  "x86_64-pc-windows-msvc": `uv-x86_64-pc-windows-msvc.zip`,
};
const BASE_URL = `https://github.com/astral-sh/uv/releases/download/${VERSION}`;
// Download, extract, rename to uv-{target-triple}[.exe]
```

### System uv vs Bundled uv

Recommended resolution order:

1. **Check for system `uv`**: `which uv` / `where uv` — if present and version is sufficient, use it
2. **Check app-local install**: Look in app data directory for a previously-downloaded uv
3. **Fall back to bundled sidecar**: Use the binary shipped with the app
4. **Auto-download on first run**: If not bundled (dev mode), download uv to app data dir

This gives users who already have uv installed a seamless experience while ensuring it works for users who don't.

### Environment Variables for uv

When shelling out to uv, you may want to set:

```bash
UV_CACHE_DIR=/path/to/app/cache     # Keep uv cache within app's data
UV_PYTHON_INSTALL_DIR=/path/to/...   # Control where Pythons are installed
UV_NO_MODIFY_PATH=1                  # Don't touch user's shell profiles
UV_PYTHON_PREFERENCE=managed         # Or "system" depending on context
```

### Size Budget Impact

For a Tauri app that already compiles to ~5-10 MB:
- Adding uv sidecar: +~15 MB compressed (+~45 MB uncompressed on disk)
- Adding PET sidecar: likely ~2-5 MB (much smaller, Rust binary)
- Total: ~20-25 MB compressed for the full app with both sidecars

This is comparable to VS Code's approach (which bundles PET) and much smaller than Electron.

---

## Tauri Shell Plugin

### Setup

```bash
cargo tauri add shell
```

In `src-tauri/src/lib.rs`:
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
```

### Spawning Processes from Rust

```rust
use tauri_plugin_shell::ShellExt;

// Simple execution (wait for completion)
let output = app_handle.shell()
    .command("uv")
    .args(["python", "list"])
    .output()
    .await?;

// Streaming execution (for long-running processes)
let (mut rx, child) = app_handle.shell()
    .command("python")
    .args(["-u", "script.py"])  // -u for unbuffered stdout
    .spawn()?;

tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                // Forward to frontend via Tauri events
                app_handle.emit("python-stdout", &line).unwrap();
            }
            CommandEvent::Stderr(line) => {
                app_handle.emit("python-stderr", &line).unwrap();
            }
            CommandEvent::Terminated(status) => {
                app_handle.emit("python-exit", &status).unwrap();
            }
            _ => {}
        }
    }
});

// Write to stdin
child.write("input data\n".as_bytes())?;
```

### Spawning from TypeScript Frontend

```typescript
import { Command } from "@tauri-apps/plugin-shell";

// Sidecar (bundled binary)
const cmd = Command.sidecar("uv", ["python", "list"]);

// Or arbitrary command (must be in shell scope permissions)
const cmd = Command.create("python", ["-u", "script.py"], {
    cwd: "/path/to/project",
    env: {
        VIRTUAL_ENV: "/path/to/.venv",
        PATH: "/path/to/.venv/bin:" + originalPath,
    },
});

// Stream stdout/stderr
cmd.stdout.on("data", (line: string) => {
    console.log("stdout:", line);
    // Update UI state
});

cmd.stderr.on("data", (line: string) => {
    console.error("stderr:", line);
});

cmd.on("close", (data) => {
    console.log("exit code:", data.code);
});

cmd.on("error", (error) => {
    console.error("spawn error:", error);
});

// Spawn (non-blocking, streaming)
const child = await cmd.spawn();

// Or execute (blocking, collects all output)
const output = await cmd.execute();
// output.stdout, output.stderr, output.code

// Write to stdin
await child.write("message\n");

// Kill
await child.kill();
```

### Permissions Configuration

In `src-tauri/capabilities/default.json`:
```json
{
  "permissions": [
    "shell:allow-spawn",
    "shell:allow-execute",
    "shell:allow-stdin-write",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "uv", "cmd": "uv", "sidecar": false },
        { "name": "python", "cmd": "python", "sidecar": false },
        { "name": "python3", "cmd": "python3", "sidecar": false },
        { "name": "conda", "cmd": "conda", "sidecar": false },
        { "name": "bundled-uv", "sidecar": true }
      ]
    }
  ]
}
```

### tauri-sidecar-manager (Optional)

Repo: https://github.com/radical-data/tauri-sidecar-manager

A Tauri plugin that wraps sidecar lifecycle management:

```rust
use tauri_sidecar_manager::{SidecarManager, SidecarConfig};

let config = SidecarConfig::builder()
    .sidecar_name("my-python-process")
    .arg("--verbose")
    .working_directory("./bin")
    .build();

app.manage(SidecarManager::new(config));
```

Frontend events: `sidecar-stdout`, `sidecar-stderr` for streaming.

Useful if you have long-lived Python processes (e.g., a ZMQ broker) that need crash detection and automatic restart.

---

## Environment Discovery Logic

### Minimum Viable Discovery

For a scientific app, you probably need to discover:

1. **venv/virtualenv** — glob for `.venv/`, `venv/`, `env/` in workspace
2. **uv-managed** — check uv's Python install directory
3. **conda** — parse `~/.conda/environments.txt`, check `CONDA_PREFIX`
4. **System Python** — scan PATH
5. **pyenv** — check `~/.pyenv/versions/`

### Detection Heuristics

**Is it a venv?**
```
{dir}/pyvenv.cfg exists
→ Parse for: home, include-system-site-packages, version
→ Python at: {dir}/bin/python (Unix) or {dir}/Scripts/python.exe (Windows)
```

**Is it a conda env?**
```
{dir}/conda-meta/history exists
→ Python at: {dir}/bin/python (Unix) or {dir}/python.exe (Windows)
→ Also check: ~/.conda/environments.txt for all known envs
```

**Is it a uv-managed Python?**
```
Check: ~/.local/share/uv/python/ (Linux)
       ~/Library/Application Support/uv/python/ (macOS)
       %LOCALAPPDATA%\uv\python\ (Windows)
→ Subdirs named like: cpython-3.12.8-linux-x86_64-gnu
→ Python at: {subdir}/bin/python3.12
```

**pyvenv.cfg parsing** (important for determining base interpreter):
```ini
home = /usr/bin
include-system-site-packages = false
version = 3.12.8
prompt = myproject
```

---

## Conda Considerations

Conda is the trickiest environment type to support well.

### Discovery

```bash
# JSON list of all environments
conda info --envs --json
# Returns: {"envs": ["/home/user/miniconda3", "/home/user/miniconda3/envs/myenv", ...]}

# Or parse the flat file directly (faster, no conda spawn needed):
cat ~/.conda/environments.txt
```

### Activation Without Sourcing Scripts

Conda activation is complex (it modifies PATH, sets env vars, runs activate.d scripts). For subprocess spawning, you need to simulate this:

```rust
fn conda_env_vars(prefix: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();

    env.insert("CONDA_PREFIX".into(), prefix.display().to_string());
    env.insert("CONDA_DEFAULT_ENV".into(),
        prefix.file_name().unwrap().to_string_lossy().into());

    // Prepend to PATH
    let bin_dir = if cfg!(windows) {
        vec![
            prefix.to_path_buf(),
            prefix.join("Library/mingw-w64/bin"),
            prefix.join("Library/usr/bin"),
            prefix.join("Library/bin"),
            prefix.join("Scripts"),
            prefix.join("bin"),
        ]
    } else {
        vec![prefix.join("bin")]
    };

    let path = std::env::var("PATH").unwrap_or_default();
    let new_path = std::env::join_paths(
        bin_dir.iter().chain(std::env::split_paths(&path).collect::<Vec<_>>().iter())
    ).unwrap();
    env.insert("PATH".into(), new_path.to_string_lossy().into());

    // Critical: unset PYTHONHOME (conda sets this during activation)
    // When spawning, use cmd.env_remove("PYTHONHOME")

    env
}
```

### Gotchas

- Python binary location differs: `{prefix}/bin/python` on Unix vs `{prefix}/python.exe` on Windows (NOT `Scripts/python.exe`)
- Some packages need `CONDA_PREFIX` to find shared libraries
- VS Code historically struggled with conda because its activation mechanisms don't align with standard discovery heuristics
- Running `conda` itself may require activation of the base environment first
- `mamba`/`micromamba` users may have different paths

---

## Spawning Python

### The "Activation Without Activation" Pattern

You don't need to source `activate` scripts. Set env vars directly:

```rust
fn spawn_in_env(
    app: &AppHandle,
    env: &PythonEnv,
    args: &[&str],
) -> Result<(Receiver<CommandEvent>, CommandChild)> {
    let mut cmd = app.shell().command(&env.python_path);
    cmd.args(args);

    match &env.kind {
        EnvKind::Venv { prefix } => {
            cmd.env("VIRTUAL_ENV", prefix);
            cmd.env("PATH", prepend_to_path(&prefix.join("bin")));
            cmd.env_remove("PYTHONHOME");
            cmd.env_remove("CONDA_PREFIX");
        }
        EnvKind::Conda { prefix } => {
            cmd.env("CONDA_PREFIX", prefix);
            cmd.env("CONDA_DEFAULT_ENV", prefix.file_name().unwrap());
            cmd.env("PATH", conda_path(prefix));
            cmd.env_remove("PYTHONHOME");
            cmd.env_remove("VIRTUAL_ENV");
        }
        EnvKind::System => {
            // No env modifications needed
        }
    }

    // Always useful:
    cmd.env("PYTHONUNBUFFERED", "1");  // Ensure stdout streams immediately
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");  // Don't pollute with .pyc

    cmd.spawn()
}
```

### Pipe Passthrough to Frontend

The flow: Python process → Rust (tauri-plugin-shell) → Tauri events → TypeScript frontend.

```
┌─────────┐  stdout  ┌───────────────┐  events  ┌──────────────┐
│ Python   │────────→│ Rust/Tauri     │────────→│ TS Frontend   │
│ Process  │←────────│ Shell Plugin   │←────────│ (WebView)     │
└─────────┘  stdin   └───────────────┘  invoke  └──────────────┘
```

For structured IPC (beyond raw stdout), you already have ZMQ/WebSocket/WebRTC channels. The stdout pipe is useful for:
- Streaming logs/progress to a terminal widget in the UI
- Simple command-response protocols (JSON lines over stdout)
- Subprocess lifecycle events (start, exit code, errors)

---

## Dev Mode

### Requirements

Developers need to:
1. Use their own Python with editable installs of packages they're developing
2. Switch between environments easily
3. Not have the app fight with their existing tooling

### Dev Mode Implementation

```rust
let python_env = if cfg!(dev) {
    // In dev mode, respect VIRTUAL_ENV if set
    if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
        PythonEnv::from_venv(PathBuf::from(venv))
    } else {
        // Fall back to discovering in the project directory
        discover_project_env(&project_root)?
    }
} else {
    // In production, use the configured/selected environment
    load_selected_env(&app_config)?
};
```

### Configuration Hierarchy

1. **CLI flag / env var** — `SLEAP_PYTHON=/path/to/python` (highest priority)
2. **App settings** — user's selected environment (stored in app config)
3. **Workspace `.python-version`** — standard uv/pyenv convention
4. **Auto-discovery** — PET scan or heuristic search
5. **Managed fallback** — use bundled uv to create a fresh environment

### Escape Hatches

- Expose a "Select Python Interpreter" UI (like VS Code) that shows all discovered environments
- Allow manual path entry for environments not discovered
- Support a config file (e.g., `sleap.toml` or similar) that pins the Python path
- For conda users: detect `CONDA_PREFIX` from the launching shell environment

---

## Relevant Projects

| Project                                    | URL                                                          | Notes                                                          |
| ------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| **PET**                                    | github.com/microsoft/python-environment-tools                | Rust env discovery, JSON-RPC API, MIT                          |
| **uv**                                     | github.com/astral-sh/uv                                      | Rust Python/package manager, single binary                     |
| **tauri-plugin-shell**                     | v2.tauri.app/plugin/shell/                                   | Process spawning, stdin/stdout/stderr streaming                |
| **tauri-sidecar-manager**                  | github.com/radical-data/tauri-sidecar-manager                | Sidecar lifecycle management plugin                            |
| **pytauri**                                | pytauri.github.io/pytauri/                                   | PyO3-based (NOT recommended for this use case)                 |
| **example-tauri-v2-python-server-sidecar** | github.com/dieharders/example-tauri-v2-python-server-sidecar | Reference for Python sidecar pattern                           |
| **vscode-python-environments**             | github.com/microsoft/vscode-python-environments              | VS Code ext consuming PET — good reference for UI patterns     |
| **scoop-uv**                               | crates.io/crates/scoop-uv                                    | Rust crate wrapping uv for env management (small, third-party) |
| **uve**                                    | github.com/robert-mcdermott/uve                              | Go-based uv env manager with conda-like UX                     |

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Tauri App                         │
│                                                     │
│  ┌──────────────┐    ┌───────────────────────────┐  │
│  │  TypeScript   │    │     Rust Backend           │  │
│  │  Frontend     │    │                           │  │
│  │              │    │  ┌───────────────────────┐ │  │
│  │  - Env picker │◄──►│  │  Env Manager Module   │ │  │
│  │  - Log viewer │    │  │                       │ │  │
│  │  - Settings   │    │  │  - Discovery (PET or  │ │  │
│  │              │    │  │    custom locators)    │ │  │
│  │              │    │  │  - uv orchestration    │ │  │
│  │              │    │  │  - Config persistence  │ │  │
│  │              │    │  │  - Env var computation │ │  │
│  │              │    │  └───────────────────────┘ │  │
│  │              │    │                           │  │
│  │              │    │  ┌───────────────────────┐ │  │
│  │  stdout ◄────┼────┼──│  Process Manager       │ │  │
│  │  stderr ◄────┼────┼──│                       │ │  │
│  │  stdin ─────►┼────┼─►│  - tauri-plugin-shell │ │  │
│  │              │    │  │  - Lifecycle mgmt     │ │  │
│  │              │    │  │  - Crash detection    │ │  │
│  │              │    │  └───────────────────────┘ │  │
│  └──────────────┘    └───────────────────────────┘  │
│                                                     │
│  Sidecars:  [uv binary]  [pet binary (optional)]    │
└─────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   ┌──────────┐            ┌─────────────┐
   │ Python   │            │ Python      │
   │ Process  │            │ Process     │
   │ (worker) │            │ (ZMQ/WS)    │
   └──────────┘            └─────────────┘
```

### Flow: First Launch

1. App starts → Rust backend initializes Env Manager
2. Env Manager checks for system `uv`, falls back to bundled sidecar
3. Env Manager runs discovery (PET or custom):
   - Scan PATH for Python interpreters
   - Check uv-managed Pythons
   - Check conda environments
   - Glob workspace for `.venv`/`venv` dirs
4. Results presented in frontend env picker
5. User selects (or auto-selects based on `.python-version` / config)
6. On "Run": Rust computes env vars, spawns Python via shell plugin
7. stdout/stderr streamed to frontend via Tauri events
8. Structured IPC proceeds over ZMQ/WebSocket/WebRTC channels

### Flow: No Python Found

1. Discovery returns empty results
2. UI prompts: "No Python environment found. Install Python 3.12 with uv?"
3. User confirms → Rust calls `uv python install 3.12` (sidecar)
4. Then `uv venv --python 3.12 .venv` in project directory
5. Then `uv pip install -e .` or `uv sync` for project deps
6. All via shell plugin with progress streamed to UI

---

## Open Questions / TODO

- [ ] Check if PET crates can be used as library dependencies (vs. sidecar)
- [ ] Verify `uv python list --format json` has landed
- [ ] Decide on config file format for persisting selected environment
- [ ] Design the env picker UI (VS Code's is a good reference)
- [ ] Handle the case where conda is installed but `conda` isn't on PATH (e.g., needs `conda init` first)
- [ ] Test uv binary size across platforms for bundle budget
- [ ] Consider whether to support pixi (conda successor from prefix.dev) in addition to conda
- [ ] Evaluate whether storing the environment manager type (like VS Code does) rather than absolute paths is better for portability