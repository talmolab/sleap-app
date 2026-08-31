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
//! GitHub Release (tag `dev`) that build-dev.yml replaces on every
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
    "https://github.com/talmolab/sleap-app/releases/download/dev/latest.json";

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
/// non-version-tagged releases like `dev`, rather than relying on
/// that tag merely happening to sort low.
///
/// Also rejects a non-numeric prerelease identifier (e.g. `v1.0.0-rc1`):
/// build-dev.yml's and deploy.yml's own bash/jq tag-format regexes only ever
/// capture a purely-numeric prerelease (`-[0-9]+`), so accepting anything
/// `semver::Version` considers valid here would let this resolver and the
/// website's `/latest/` path disagree about which release is newest.
fn parse_tag_version(tag: &str) -> Option<Version> {
    let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()?;
    if !version.pre.is_empty() && !version.pre.as_str().chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(version)
}

/// Finds whichever non-draft release/pre-release is newest AND has a
/// `latest.json` asset, and returns that release's own manifest URL.
async fn resolve_latest_endpoint() -> Result<url::Url, String> {
    let client = reqwest::Client::builder()
        .user_agent("sleap-app-updater")
        .build()
        .map_err(|e| e.to_string())?;

    // Pages through every release rather than trusting the repo to stay
    // under 100 forever -- build-dev.yml's and deploy.yml's equivalent
    // bash/jq logic already uses `gh api --paginate` for the same reason; a
    // release beyond the first page must not go invisible to this resolver
    // while the website's /latest/ path (which does paginate) still sees it.
    let mut releases: Vec<GhRelease> = Vec::new();
    let mut page: u32 = 1;
    loop {
        let api_url =
            format!("https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}");
        let batch: Vec<GhRelease> = client
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
        let batch_len = batch.len();
        releases.extend(batch);
        if batch_len < 100 {
            break;
        }
        page += 1;
    }

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

/// Decides whether `release` should be offered, given what's currently
/// running. Pulled out of the `version_comparator` closure so it's unit
/// testable without a live `Updater`/network access.
///
/// Default (`allow_downgrade: false`) matches tauri-plugin-updater's own
/// fallback (`release.version > current`) exactly -- this function is used
/// unconditionally (not just when overriding) so that behavior is covered by
/// the same tests as the `allow_downgrade: true` path below.
///
/// With `allow_downgrade: true` (explicit channel switch -- see
/// `check_update`'s doc comment): the default `>` comparison would treat a
/// `dev` build as already newer than any `stable`/`latest` release of the
/// same base version, since `Version`'s derived `Ord` also orders by build
/// metadata (a non-empty `+build` sorts above an empty one) -- even though
/// it's a DIFFERENT, non-tagged build a user may want to move off of.
/// Comparing on inequality instead surfaces (and allows installing) that
/// channel's real current version, upgrade or downgrade.
fn should_offer_update(current: &Version, release: &Version, allow_downgrade: bool) -> bool {
    if allow_downgrade {
        release != current
    } else {
        release > current
    }
}

async fn build_updater<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    allow_downgrade: bool,
) -> Result<Updater, String> {
    let endpoint = endpoint_for(channel).await?;
    let builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .version_comparator(move |current, release| {
            should_offer_update(&current, &release.version, allow_downgrade)
        });
    builder.build().map_err(|e| e.to_string())
}

/// Info about a pending update, serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// Checks the given channel's manifest for a version newer than what's
/// running -- or, with `allow_downgrade`, for whichever version that channel
/// currently points at, even if it's older than what's running. The latter
/// is for an explicit channel switch (e.g. moving from `dev` back to
/// `stable`), where the user wants to move to that channel's real current
/// version, not just be told there's nothing "newer".
#[tauri::command]
pub async fn check_update<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
    allow_downgrade: bool,
) -> Result<Option<UpdateInfo>, String> {
    let updater = build_updater(&app, &channel, allow_downgrade).await?;
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
///
/// `allow_downgrade` must match whatever `check_update` call produced
/// `expected_version` (see its doc comment) — otherwise this re-check would
/// use stricter "newer only" semantics than the one that showed the user the
/// button, and could wrongly report "no update available" for an intentional
/// channel-switch downgrade.
#[tauri::command]
pub async fn install_update<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
    expected_version: String,
    allow_downgrade: bool,
) -> Result<(), String> {
    let updater = build_updater(&app, &channel, allow_downgrade).await?;
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
        assert!(parse_tag_version("dev").is_none());
        assert!(parse_tag_version("").is_none());
    }

    #[test]
    fn rejects_non_numeric_prerelease_tags() {
        // build-dev.yml/deploy.yml's bash/jq tag-format regexes only ever
        // capture a purely-numeric prerelease -- a tag like this would be
        // invisible to their HIGHEST/BASE computations, so it must be
        // rejected here too rather than silently winning "latest" candidacy.
        assert!(parse_tag_version("v1.0.0-rc1").is_none());
        assert!(parse_tag_version("v1.0.0-alpha").is_none());
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

    mod should_offer_update_tests {
        use super::*;

        #[test]
        fn strict_mode_offers_a_genuinely_newer_release() {
            let current = Version::parse("1.4.0").unwrap();
            let release = Version::parse("1.5.0").unwrap();
            assert!(should_offer_update(&current, &release, false));
        }

        #[test]
        fn strict_mode_refuses_an_older_release() {
            let current = Version::parse("1.5.0").unwrap();
            let release = Version::parse("1.4.0").unwrap();
            assert!(!should_offer_update(&current, &release, false));
        }

        // The bug this whole feature exists to fix: a dev build's version is
        // stamped as `BASE+<run_number>.<short_sha>` (build-dev.yml). Per
        // Version's derived Ord, a non-empty `+build` sorts ABOVE an empty
        // one at the same major.minor.patch.pre, so in strict mode the
        // *build itself* looks newer than the plain stable tag of the same
        // base -- hiding the channel-switch entirely.
        #[test]
        fn strict_mode_hides_a_same_base_dev_build_from_stable() {
            let current = Version::parse("1.5.0+42.abc1234").unwrap();
            let release = Version::parse("1.5.0").unwrap();
            assert!(!should_offer_update(&current, &release, false));
        }

        #[test]
        fn allow_downgrade_surfaces_that_same_base_dev_build_case() {
            let current = Version::parse("1.5.0+42.abc1234").unwrap();
            let release = Version::parse("1.5.0").unwrap();
            assert!(should_offer_update(&current, &release, true));
        }

        // The scenario from the conversation: running a dev build whose base
        // is ahead of the last real stable tag (dev builds off `main`, which
        // is ahead of the last release). Strict mode says "no update" (dev's
        // base outranks stable's); allow_downgrade must still offer the
        // switch since it's a genuinely different version.
        #[test]
        fn allow_downgrade_offers_switch_to_an_older_base_version() {
            let current = Version::parse("1.5.0+42.abc1234").unwrap();
            let release = Version::parse("1.4.0").unwrap();
            assert!(!should_offer_update(&current, &release, false));
            assert!(should_offer_update(&current, &release, true));
        }

        #[test]
        fn allow_downgrade_offers_a_genuinely_newer_release_too() {
            let current = Version::parse("1.4.0").unwrap();
            let release = Version::parse("1.5.0").unwrap();
            assert!(should_offer_update(&current, &release, true));
        }

        #[test]
        fn allow_downgrade_does_not_offer_the_exact_same_version() {
            let current = Version::parse("1.5.0").unwrap();
            let release = Version::parse("1.5.0").unwrap();
            assert!(!should_offer_update(&current, &release, true));
        }
    }
}
