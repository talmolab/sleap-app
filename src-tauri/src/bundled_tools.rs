//! Where the bundled ffmpeg / ffprobe live in a Linux .deb / .rpm install, and
//! putting that directory on the PATH of processes the app launches (#507).
//!
//! Tauri's `externalBin` puts sidecars next to the main binary. For the .deb /
//! .rpm that is `/usr/bin`, so the packages used to install `/usr/bin/ffmpeg` —
//! a system-wide ffmpeg that clashes with the distro's (or RPM Fusion's) own
//! package. `tauri.linux.conf.json` therefore drops `externalBin` on Linux and
//! installs the two tools into the package's private directory instead
//! ([`LINUX_PACKAGE_TOOLS_DIR`], off PATH). The AppImage keeps them in its own
//! `usr/bin` (inside the image, never on the system), and macOS / Windows are
//! untouched.
//!
//! Because they are no longer on PATH, the app:
//! - spawns them by absolute path from the frontend (scoped `shell:allow-*`
//!   entries named [`LINUX_PACKAGE_SCOPE_NAMES`]), and
//! - prepends the private dir to the PATH of every child it launches (sleap-nn,
//!   sleap-io, ...; see `environment::augmented_path`), so those tools still
//!   find an ffmpeg. The user's own shell PATH is never changed.

use std::path::{Path, PathBuf};

/// Private directory the Linux .deb / .rpm install ffmpeg + ffprobe into. It is
/// the same `/usr/lib/<productName>` directory Tauri already creates (and the
/// rpm already owns) for the app's resources.
///
/// Must match: `tauri.linux.conf.json` (deb/rpm `files`), the `linux-pkg-*`
/// shell scope entries in `capabilities/default.json` and in
/// `localhost_capability` (lib.rs), and `LINUX_PKG_*` in
/// `src/lib/transcode/ffmpegCommand.ts`. The tests below check the Rust/JSON side.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux-only (+ tests)
pub const LINUX_PACKAGE_TOOLS_DIR: &str = "/usr/lib/SLEAP";

/// Where a .deb / .rpm installs the main app binary. Only an app running from
/// here is "the package install" — an AppImage or a dev build that happens to
/// share the machine with a .deb keeps using its own sidecars.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux-only (+ tests)
const LINUX_PACKAGE_BIN_DIR: &str = "/usr/bin";

/// Shell-scope names (capabilities) for the package's private ffmpeg / ffprobe.
#[cfg(test)]
const LINUX_PACKAGE_SCOPE_NAMES: [&str; 2] = ["linux-pkg-ffmpeg", "linux-pkg-ffprobe"];

/// The private tools dir to use, given where the running binary lives and a way
/// to ask whether a file exists. `None` unless the binary is the package's
/// `/usr/bin` one AND the private ffmpeg is really there. Pure, so it is
/// testable on every OS.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // Linux-only (+ tests)
pub fn package_tools_dir_for(exe: &Path, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if exe.parent()? != Path::new(LINUX_PACKAGE_BIN_DIR) {
        return None;
    }
    let dir = PathBuf::from(LINUX_PACKAGE_TOOLS_DIR);
    is_file(&dir.join("ffmpeg")).then_some(dir)
}

/// The private tools dir for THIS process: Linux .deb / .rpm installs only;
/// always `None` on macOS, Windows, the AppImage and dev builds.
pub fn package_tools_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe().ok()?;
        package_tools_dir_for(&exe, |p| p.is_file())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// `dirs` with `tools_dir` (if any) put FIRST. Prepending means the app's own
/// ffmpeg wins for the processes it launches, which is what those processes
/// got before, when it sat in `/usr/bin`.
pub fn with_tools_dir_first(tools_dir: Option<PathBuf>, dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    match tools_dir {
        Some(t) => std::iter::once(t).chain(dirs).collect(),
        None => dirs,
    }
}

/// Frontend query: the private tools dir when the app should run ffmpeg /
/// ffprobe from there (Linux .deb / .rpm), else `None` (use the sidecar).
#[tauri::command]
pub fn linux_package_tools_dir() -> Option<String> {
    package_tools_dir().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn pkg(tool: &str) -> PathBuf {
        PathBuf::from(LINUX_PACKAGE_TOOLS_DIR).join(tool)
    }

    // The .deb/.rpm binary with its private ffmpeg present -> use the private dir.
    #[test]
    fn package_install_uses_private_dir() {
        let got = package_tools_dir_for(Path::new("/usr/bin/sleap-app"), |p| p == pkg("ffmpeg"));
        assert_eq!(got, Some(PathBuf::from(LINUX_PACKAGE_TOOLS_DIR)));
    }

    // An AppImage, dev build or anything not in /usr/bin keeps its own sidecar,
    // even when a .deb's private ffmpeg also exists on the machine.
    #[test]
    fn non_package_binaries_ignore_private_dir() {
        for exe in [
            "/tmp/.mount_SLEAPx/usr/bin/sleap-app",
            "/home/me/sleap-app/src-tauri/target/debug/sleap-app",
            "/usr/local/bin/sleap-app",
            "/Applications/SLEAP.app/Contents/MacOS/sleap-app",
        ] {
            assert_eq!(
                package_tools_dir_for(Path::new(exe), |_| true),
                None,
                "{exe}"
            );
        }
    }

    // A package binary whose private ffmpeg is missing (half-removed install)
    // must not point children at an empty dir.
    #[test]
    fn missing_private_ffmpeg_means_none() {
        assert_eq!(
            package_tools_dir_for(Path::new("/usr/bin/sleap-app"), |_| false),
            None
        );
    }

    // The PATH order: private dir first, then everything else unchanged.
    #[test]
    fn tools_dir_is_prepended_and_rest_kept() {
        let rest = vec![
            PathBuf::from("/home/me/.local/bin"),
            PathBuf::from("/usr/bin"),
        ];
        let got = with_tools_dir_first(Some(PathBuf::from(LINUX_PACKAGE_TOOLS_DIR)), rest.clone());
        assert_eq!(got[0], PathBuf::from(LINUX_PACKAGE_TOOLS_DIR));
        assert_eq!(&got[1..], &rest[..]);
        // No tools dir (macOS, Windows, AppImage): PATH is exactly what it was.
        assert_eq!(with_tools_dir_first(None, rest.clone()), rest);
    }

    // Off Linux the app must never report a private dir (macOS/Windows unchanged).
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn never_active_off_linux() {
        assert_eq!(package_tools_dir(), None);
    }

    // The packaging config must install the tools where the app looks for them:
    // deb + rpm into the private dir, AppImage into its own usr/bin, and no
    // externalBin on Linux (which would put them back in /usr/bin).
    #[test]
    fn linux_bundle_config_matches_tools_dir() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.linux.conf.json")).unwrap();
        let bundle = &conf["bundle"];
        assert_eq!(bundle["externalBin"], Value::Array(vec![]));
        for fmt in ["deb", "rpm"] {
            let files = bundle["linux"][fmt]["files"].as_object().unwrap();
            for tool in ["ffmpeg", "ffprobe"] {
                let key = format!("{LINUX_PACKAGE_TOOLS_DIR}/{tool}");
                assert!(files.contains_key(&key), "{fmt} must install {key}");
            }
            assert!(
                !files.keys().any(|k| k.starts_with("/usr/bin")),
                "{fmt} must not install anything into /usr/bin"
            );
        }
        let appimage = bundle["linux"]["appimage"]["files"].as_object().unwrap();
        for tool in ["ffmpeg", "ffprobe"] {
            let key = format!("/usr/bin/{tool}");
            assert!(appimage.contains_key(&key), "AppImage keeps {key}");
        }
    }

    /// `(permission id, scope name, cmd)` for every `linux-pkg-*` scope entry
    /// under `shell:allow-spawn` / `shell:allow-execute` in a capability.
    fn scope_cmds(cap: &Value) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for perm in cap["permissions"].as_array().unwrap() {
            let id = perm["identifier"].as_str().unwrap_or_default();
            if id != "shell:allow-spawn" && id != "shell:allow-execute" {
                continue;
            }
            for entry in perm["allow"].as_array().unwrap() {
                let name = entry["name"].as_str().unwrap_or_default();
                if LINUX_PACKAGE_SCOPE_NAMES.contains(&name) {
                    let cmd = entry["cmd"].as_str().unwrap_or_default();
                    out.push((id.to_string(), name.to_string(), cmd.to_string()));
                }
            }
        }
        out
    }

    fn assert_scope_points_at_tools_dir(cap: &Value, which: &str) {
        let cmds = scope_cmds(cap);
        // 2 tools x (spawn + execute)
        assert_eq!(
            cmds.len(),
            4,
            "{which}: expected 4 linux-pkg scope entries, got {cmds:?}"
        );
        for (id, name, cmd) in cmds {
            let tool = name.trim_start_matches("linux-pkg-");
            assert_eq!(cmd, pkg(tool).to_string_lossy(), "{which} {id} {name}");
        }
    }

    // The frontend may only spawn the private tools if BOTH capability sets
    // (local tauri:// and the runtime http://localhost one) allow that path.
    #[test]
    fn capabilities_allow_private_tools() {
        let local: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_scope_points_at_tools_dir(&local, "capabilities/default.json");
        let remote: Value = serde_json::from_str(&crate::localhost_capability(1430)).unwrap();
        assert_scope_points_at_tools_dir(&remote, "localhost_capability");
    }
}
