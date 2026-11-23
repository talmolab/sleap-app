//! Where the bundled ffmpeg / ffprobe live on Linux, and putting that directory
//! on the PATH of processes the app launches (#507).
//!
//! Tauri's `externalBin` puts sidecars next to the main binary. For the .deb /
//! .rpm that is `/usr/bin`, so the packages used to install `/usr/bin/ffmpeg` —
//! a system-wide ffmpeg that clashes with the distro's (or RPM Fusion's) own
//! package. So on Linux, `tauri.linux.conf.json` empties `externalBin` and ships
//! the two tools as plain **resources** instead. They land in Tauri's resource
//! dir, which is:
//!
//! | Linux build | resource dir                         |
//! |-------------|--------------------------------------|
//! | .deb / .rpm | `/usr/lib/SLEAP` (off PATH)          |
//! | AppImage    | `$APPDIR/usr/lib/SLEAP` (in the image) |
//! | `tauri dev` | `src-tauri/target/<profile>`         |
//!
//! One code path for all of them:
//! - The frontend runs them through the scoped shell entries
//!   [`SCOPE_NAMES`] (`cmd: "$RESOURCE/<tool>"`), never `Command.sidecar` —
//!   tauri-plugin-shell rejects any sidecar that is not in the compiled
//!   config's `externalBin`, which is empty on Linux.
//! - The resource dir is prepended to the PATH of every child the app launches
//!   (sleap-nn, sleap-io, ...; see `environment::augmented_path`), so those
//!   tools still find an ffmpeg. The user's own shell PATH is never changed.
//!
//! macOS and Windows keep their `externalBin` sidecars; nothing here applies.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Shell-scope names (capabilities) for the Linux bundled tools, whose `cmd` is
/// `$RESOURCE/<tool>`. Must match `capabilities/default.json`,
/// `localhost_capability` (lib.rs) and `BUNDLED_SCOPE` in
/// `src/lib/transcode/ffmpegCommand.ts`; the tests below check the Rust/JSON side.
#[cfg(test)]
const SCOPE_NAMES: [(&str, &str); 2] =
    [("ffmpeg", "bundled-ffmpeg"), ("ffprobe", "bundled-ffprobe")];

/// The Linux tools dir (= the app's resource dir), set once in `setup()`.
/// Stays unset on macOS / Windows.
static TOOLS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the bundled tools live for this build: the resource dir on Linux,
/// `None` elsewhere (those platforms use sidecars). Pure, so testable anywhere.
/// Deliberately does NOT look at where the binary runs from or whether the file
/// exists: on Linux there is no sidecar to fall back to, so every Linux build
/// (deb, rpm, AppImage, dev) must take this path.
pub fn tools_dir_for(is_linux: bool, resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if is_linux {
        resource_dir
    } else {
        None
    }
}

/// Record the tools dir. Call once from `setup()`.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(dir) = tools_dir_for(cfg!(target_os = "linux"), app.path().resource_dir().ok()) {
        let _ = TOOLS_DIR.set(dir);
    }
}

/// The dir to put first on children's PATH: the Linux tools dir, but only when
/// the bundled ffmpeg is really in it (an unfetched dev checkout has none, and
/// an empty entry would only add noise).
pub fn children_tools_dir() -> Option<PathBuf> {
    TOOLS_DIR
        .get()
        .filter(|d| d.join("ffmpeg").is_file())
        .cloned()
}

/// `dirs` with `tools_dir` (if any) put FIRST. Prepending means the app's own
/// ffmpeg wins for the processes it launches — what they got before, when it
/// sat in /usr/bin (or, in the AppImage, in the image's PATH).
pub fn with_tools_dir_first(tools_dir: Option<PathBuf>, dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    match tools_dir {
        Some(t) => std::iter::once(t).chain(dirs).collect(),
        None => dirs,
    }
}

/// Fallback when `join_paths` refuses the list (an inherited PATH entry that
/// itself contains the separator): keep the raw inherited PATH as-is, but
/// still put the tools dir in front of it.
pub fn prepend_raw(tools_dir: Option<&Path>, raw: OsString) -> OsString {
    let Some(dir) = tools_dir else { return raw };
    let mut out = OsString::from(dir);
    if !raw.is_empty() {
        out.push(if cfg!(windows) { ";" } else { ":" });
        out.push(raw);
    }
    out
}

/// Frontend query: the Linux tools dir (run ffmpeg / ffprobe through the
/// `bundled-*` scoped commands), or `None` on macOS / Windows (use sidecars).
#[tauri::command]
pub fn linux_tools_dir() -> Option<String> {
    TOOLS_DIR.get().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// RFC 7396 JSON merge patch — what Tauri does with `tauri.linux.conf.json`
    /// (objects merge, everything else, arrays included, is replaced).
    fn merge(base: &mut Value, patch: &Value) {
        match (base, patch) {
            (Value::Object(b), Value::Object(p)) => {
                for (k, v) in p {
                    if v.is_null() {
                        b.remove(k);
                    } else {
                        merge(b.entry(k.clone()).or_insert(Value::Null), v);
                    }
                }
            }
            (b, p) => *b = p.clone(),
        }
    }

    /// The config Tauri compiles into a Linux build.
    fn linux_config() -> Value {
        let mut base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let patch: Value = serde_json::from_str(include_str!("../tauri.linux.conf.json")).unwrap();
        merge(&mut base, &patch);
        base
    }

    // Every Linux build — deb/rpm, AppImage, dev — must use the tools dir:
    // the AppImage/dev builds once fell back to sidecars, which Linux rejects.
    #[test]
    fn linux_always_uses_the_resource_dir() {
        for dir in [
            "/usr/lib/SLEAP",
            "/tmp/.mount_SLEAPx/usr/lib/SLEAP",
            "/home/me/app/src-tauri/target/debug",
        ] {
            assert_eq!(
                tools_dir_for(true, Some(dir.into())),
                Some(PathBuf::from(dir))
            );
        }
    }

    // macOS / Windows keep their sidecars: never a tools dir, PATH unchanged.
    #[test]
    fn other_platforms_never_use_a_tools_dir() {
        assert_eq!(
            tools_dir_for(
                false,
                Some("/Applications/SLEAP.app/Contents/Resources".into())
            ),
            None
        );
    }

    // The PATH order: tools dir first, then everything else unchanged.
    #[test]
    fn tools_dir_is_prepended_and_rest_kept() {
        let rest = vec![
            PathBuf::from("/home/me/.local/bin"),
            PathBuf::from("/usr/bin"),
        ];
        let got = with_tools_dir_first(Some("/usr/lib/SLEAP".into()), rest.clone());
        assert_eq!(got[0], PathBuf::from("/usr/lib/SLEAP"));
        assert_eq!(&got[1..], &rest[..]);
        assert_eq!(with_tools_dir_first(None, rest.clone()), rest);
    }

    // If join_paths fails, the raw-PATH fallback must still carry the tools dir.
    #[cfg(unix)]
    #[test]
    fn raw_fallback_keeps_tools_dir_first() {
        let raw = OsString::from("/odd:dir:/usr/bin");
        assert_eq!(
            prepend_raw(Some(Path::new("/usr/lib/SLEAP")), raw.clone()),
            OsString::from("/usr/lib/SLEAP:/odd:dir:/usr/bin")
        );
        assert_eq!(prepend_raw(None, raw.clone()), raw);
        assert_eq!(
            prepend_raw(Some(Path::new("/usr/lib/SLEAP")), OsString::new()),
            OsString::from("/usr/lib/SLEAP")
        );
    }

    // The bug the first version shipped: Linux emptied externalBin (so the
    // plugin rejects every sidecar) while AppImage/dev still asked for one.
    // On Linux the frontend's commands must be allowed by the LINUX config:
    // no sidecars at all, and each tool shipped as a resource at the exact
    // place its `$RESOURCE/<tool>` scope entry points to.
    #[test]
    fn linux_runtime_config_allows_what_the_frontend_runs() {
        let conf = linux_config();
        let bundle = &conf["bundle"];
        assert_eq!(
            bundle["externalBin"],
            Value::Array(vec![]),
            "no sidecars on Linux (they'd go to /usr/bin)"
        );
        let resources = bundle["resources"]
            .as_object()
            .expect("Linux resources must be a src->target map");
        for (tool, _) in SCOPE_NAMES {
            let src = format!("binaries/{tool}-x86_64-unknown-linux-gnu");
            assert_eq!(
                resources.get(&src).and_then(Value::as_str),
                Some(tool),
                "{src} must ship as resource `{tool}`"
            );
        }
        assert!(
            bundle["linux"]["deb"].get("files").is_none()
                && bundle["linux"]["rpm"].get("files").is_none()
        );
    }

    // The Linux resources map replaces the base list, so it must still ship
    // every base resource at its original path.
    #[test]
    fn linux_resources_keep_base_resources() {
        let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let linux = linux_config();
        let map = linux["bundle"]["resources"].as_object().unwrap();
        for r in base["bundle"]["resources"].as_array().unwrap() {
            let r = r.as_str().unwrap();
            assert_eq!(
                map.get(r).and_then(Value::as_str),
                Some(r),
                "base resource {r} dropped/moved on Linux"
            );
        }
    }

    // macOS / Windows still rely on sidecars: base externalBin unchanged.
    #[test]
    fn base_config_keeps_sidecars() {
        let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            base["bundle"]["externalBin"],
            serde_json::json!(["binaries/ffmpeg", "binaries/ffprobe"])
        );
    }

    fn assert_scope_entries(cap: &Value, which: &str) {
        let mut seen = 0;
        for perm in cap["permissions"].as_array().unwrap() {
            let id = perm["identifier"].as_str().unwrap_or_default();
            if id != "shell:allow-spawn" && id != "shell:allow-execute" {
                continue;
            }
            for (tool, name) in SCOPE_NAMES {
                let entry = perm["allow"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["name"] == name);
                let cmd = entry.and_then(|e| e["cmd"].as_str());
                assert_eq!(
                    cmd,
                    Some(format!("$RESOURCE/{tool}").as_str()),
                    "{which} {id} {name}"
                );
                seen += 1;
            }
        }
        assert_eq!(seen, 4, "{which}: spawn + execute x 2 tools");
    }

    // The frontend may only spawn the tools if BOTH capability sets (local
    // tauri:// and the runtime http://localhost one) allow `$RESOURCE/<tool>`.
    #[test]
    fn capabilities_allow_bundled_tools() {
        let local: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_scope_entries(&local, "capabilities/default.json");
        let remote: Value = serde_json::from_str(&crate::localhost_capability(1430)).unwrap();
        assert_scope_entries(&remote, "localhost_capability");
    }
}
