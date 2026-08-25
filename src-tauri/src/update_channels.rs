//! Multi-channel self-update: `stable` / `latest` / `dev`.
//!
//! `tauri-plugin-updater`'s JS `check()` binding has no per-call endpoint
//! override in the installed version (2.10.1) — its `CheckOptions` only
//! exposes `headers`/`timeout`/`proxy`/`target`/`allowDowngrades`. Endpoints
//! are otherwise fixed at build time from `tauri.conf.json`. So channel
//! switching happens here instead: each call builds a fresh `Updater` via
//! `UpdaterExt::updater_builder().endpoints(...)`, which IS overridable per
//! call on the Rust side. The frontend only ever sends a channel name — never
//! a URL — and this module maps it to a manifest.
//!
//! `stable` and `dev` are simple static manifest URLs. `dev` is a rolling
//! GitHub Release (tag `channel-dev`) that build-dev.yml replaces on every
//! push to `main`.
//!
//! `latest` ("pre-release or release, whichever is newest") is resolved
//! DYNAMICALLY on every check by querying the GitHub Releases API directly
//! for whichever non-draft release/pre-release is newest AND actually has a
//! `latest.json` asset (this also skips releases like v0.1.0/v0.1.1, which
//! shipped with none). There is deliberately no CI-maintained rolling
//! "latest" release to go stale or need bootstrapping — this always reflects
//! whatever is really on GitHub Releases right now, including releases
//! published before this channel system existed.

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Updater, UpdaterExt};

const REPO: &str = "talmolab/sleap-app";

const ENDPOINT_STABLE: &str =
    "https://github.com/talmolab/sleap-app/releases/latest/download/latest.json";
const ENDPOINT_DEV: &str =
    "https://github.com/talmolab/sleap-app/releases/download/channel-dev/latest.json";

#[derive(Deserialize)]
struct GhAsset {
    name: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<GhAsset>,
}

/// Parses a GitHub release tag as a real version, or `None` if it isn't one.
/// Using a real semver parser (rather than hand-rolled splitting) means a
/// release whose tag doesn't match `vX.Y.Z`/`vX.Y.Z-N` (see build.yml's
/// `validate` job) is explicitly EXCLUDED from "latest" candidacy instead of
/// silently sorting as version 0 — which also naturally excludes rolling,
/// non-version-tagged releases like `channel-dev`, rather than relying on
/// that tag merely happening to sort low.
fn parse_tag_version(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// Finds whichever non-draft release/pre-release is newest AND has a
/// `latest.json` asset, and returns that release's own manifest URL.
async fn resolve_latest_endpoint() -> Result<url::Url, String> {
    let api_url = format!("https://api.github.com/repos/{REPO}/releases?per_page=100");
    let client = reqwest::Client::builder()
        .user_agent("sleap-app-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let releases: Vec<GhRelease> = client
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let best = releases
        .iter()
        .filter(|r| !r.draft)
        .filter(|r| r.assets.iter().any(|a| a.name == "latest.json"))
        .filter_map(|r| parse_tag_version(&r.tag_name).map(|v| (v, r)))
        .max_by(|(v1, _), (v2, _)| v1.cmp(v2))
        .map(|(_, r)| r)
        .ok_or_else(|| {
            "no GitHub release has both a valid version tag and a latest.json manifest"
                .to_string()
        })?;

    url::Url::parse(&format!(
        "https://github.com/{REPO}/releases/download/{}/latest.json",
        best.tag_name
    ))
    .map_err(|e| e.to_string())
}

async fn endpoint_for(channel: &str) -> Result<url::Url, String> {
    match channel {
        "stable" => url::Url::parse(ENDPOINT_STABLE).map_err(|e| e.to_string()),
        "latest" => resolve_latest_endpoint().await,
        "dev" => url::Url::parse(ENDPOINT_DEV).map_err(|e| e.to_string()),
        other => Err(format!("unknown update channel: {other}")),
    }
}

async fn build_updater<R: Runtime>(app: &AppHandle<R>, channel: &str) -> Result<Updater, String> {
    let endpoint = endpoint_for(channel).await?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// Info about a pending update, serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// Checks the given channel's manifest for a version newer than what's running.
#[tauri::command]
pub async fn check_update<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
) -> Result<Option<UpdateInfo>, String> {
    let updater = build_updater(&app, &channel).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        notes: u.body,
        pub_date: u.date.map(|d| d.to_string()),
    }))
}

/// Re-checks the given channel, then downloads and installs the update if one
/// is available. The frontend is expected to relaunch the app once this
/// resolves.
///
/// `expected_version` pins this to the exact version the user saw and clicked
/// "Update" for: if a newer release lands on the channel in the moments
/// between that render and this call, we refuse to silently install the
/// different version — the frontend re-checks and asks again instead.
#[tauri::command]
pub async fn install_update<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
    expected_version: String,
) -> Result<(), String> {
    let updater = build_updater(&app, &channel).await?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    if update.version != expected_version {
        return Err(format!(
            "a newer version (v{}) became available since you last checked — please check again",
            update.version
        ));
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_and_prerelease_tags() {
        assert_eq!(parse_tag_version("v0.1.1").unwrap(), Version::new(0, 1, 1));
        assert_eq!(
            parse_tag_version("v0.1.2-1").unwrap(),
            Version::parse("0.1.2-1").unwrap()
        );
        // Without the "v" prefix works too.
        assert_eq!(parse_tag_version("0.1.1").unwrap(), Version::new(0, 1, 1));
    }

    #[test]
    fn rejects_non_version_tags() {
        // The rolling dev-channel release tag must never be mistaken for a
        // real version by the "latest" resolver.
        assert!(parse_tag_version("channel-dev").is_none());
        assert!(parse_tag_version("dev").is_none());
        assert!(parse_tag_version("").is_none());
    }

    #[test]
    fn a_release_outranks_a_prerelease_of_the_same_base() {
        let release = parse_tag_version("v0.1.2").unwrap();
        let prerelease = parse_tag_version("v0.1.2-1").unwrap();
        assert!(release > prerelease);
    }

    #[test]
    fn higher_prerelease_number_outranks_lower() {
        let newer = parse_tag_version("v0.1.2-2").unwrap();
        let older = parse_tag_version("v0.1.2-1").unwrap();
        assert!(newer > older);
    }

    #[test]
    fn higher_base_version_outranks_any_prerelease() {
        let newer_base = parse_tag_version("v0.2.0").unwrap();
        let older_prerelease = parse_tag_version("v0.1.2-99").unwrap();
        assert!(newer_base > older_prerelease);
    }
}
