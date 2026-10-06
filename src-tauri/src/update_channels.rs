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
//! `dev` is a simple static manifest URL: a rolling GitHub Release (tag
//! `dev`) that build-dev.yml replaces on every push to `main`, so the URL
//! never changes and always has a manifest.
//!
//! `stable` and `latest` are both resolved DYNAMICALLY on every check by
//! querying the GitHub Releases API for whichever non-draft release is
//! newest AND actually has a `latest.json` asset -- `latest` over releases
//! and pre-releases alike, `stable` over full releases only. There is
//! deliberately no CI-maintained rolling release for either to go stale or
//! need bootstrapping: this always reflects whatever is really on GitHub
//! Releases right now, including releases published before this channel
//! system existed.
//!
//! `stable` used to be the static `releases/latest/download/latest.json`,
//! which resolves to whatever GitHub itself calls the latest release -- the
//! newest NON-pre-release, with no regard for whether it carries a manifest.
//! v0.1.0 and v0.1.1 shipped before updater artifacts existed, so that URL
//! 404'd for every user on the default channel, and would 404 again for any
//! future full release published without a `latest.json` (e.g. one whose
//! platform legs failed). Filtering on the asset skips those and falls back
//! to the newest full release that CAN actually be installed. The cost is
//! one GitHub API call per check where there used to be none; the
//! frontend's 1h cache (src/lib/updateCheckCache.ts) holds that to roughly
//! one call per hour per channel per session.

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Updater, UpdaterExt};

const REPO: &str = "talmolab/sleap-app";

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
    prerelease: bool,
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

/// Picks the installable release for a channel: newest by version among
/// non-draft releases that carry a `latest.json` manifest, restricted to
/// full releases when `full_releases_only`.
///
/// Split out from the HTTP call above purely so it can be tested -- it is
/// the whole of what distinguishes `stable` from `latest`, and getting the
/// manifest filter wrong is what made `stable` 404.
fn pick_release(releases: &[GhRelease], full_releases_only: bool) -> Option<&GhRelease> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter(|r| !(full_releases_only && r.prerelease))
        .filter(|r| r.assets.iter().any(|a| a.name == "latest.json"))
        .filter_map(|r| parse_tag_version(&r.tag_name).map(|v| (v, r)))
        .max_by(|(v1, _), (v2, _)| v1.cmp(v2))
        .map(|(_, r)| r)
}

/// How long any single update-related network call may take. Without this,
/// a connection that stalls rather than refuses (flaky wifi, a captive
/// portal, a proxy that blackholes) leaves the check pending indefinitely --
/// and a `check_update` that never returns used to leave the Environment
/// panel's channel dropdown disabled forever, with no spinner or error to
/// say why (see EnvironmentPanel.tsx). Every failure mode has to be
/// observable, so every one of them has to terminate.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(20);

/// Finds whichever non-draft release is newest AND has a `latest.json`
/// asset, and returns that release's own manifest URL.
///
/// `full_releases_only` picks the channel: `false` considers releases and
/// pre-releases alike (`latest`), `true` only full releases (`stable`).
async fn resolve_release_endpoint(full_releases_only: bool) -> Result<url::Url, String> {
    let client = reqwest::Client::builder()
        .user_agent("sleap-app-updater")
        .timeout(NETWORK_TIMEOUT)
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

    let best = pick_release(&releases, full_releases_only).ok_or_else(|| {
        // Reachable today on `stable`: every release carrying a
        // latest.json so far is a pre-release. Say so plainly -- the
        // frontend surfaces this string, and "no stable release yet"
        // is a state to explain, not an error to look broken.
        if full_releases_only {
            "no full release has a latest.json manifest yet (only pre-releases do) \
                 -- switch to the Latest or Dev channel to get builds before the first \
                 stable release"
                .to_string()
        } else {
            "no GitHub release has both a valid version tag and a latest.json manifest".to_string()
        }
    })?;

    url::Url::parse(&format!(
        "https://github.com/{REPO}/releases/download/{}/latest.json",
        best.tag_name
    ))
    .map_err(|e| e.to_string())
}

async fn endpoint_for(channel: &str) -> Result<url::Url, String> {
    match channel {
        "stable" => resolve_release_endpoint(true).await,
        "latest" => resolve_release_endpoint(false).await,
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
        // Same reasoning as NETWORK_TIMEOUT above, for the plugin's own
        // manifest fetch -- resolving the endpoint and then hanging while
        // downloading latest.json is the identical failure from the user's
        // side.
        .timeout(NETWORK_TIMEOUT)
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

    mod pick_release_tests {
        use super::*;

        fn rel(tag: &str, prerelease: bool, manifest: bool) -> GhRelease {
            GhRelease {
                tag_name: tag.to_string(),
                draft: false,
                prerelease,
                assets: if manifest {
                    vec![GhAsset {
                        name: "latest.json".to_string(),
                    }]
                } else {
                    vec![GhAsset {
                        name: "SLEAP_macos.app.tar.gz".to_string(),
                    }]
                },
            }
        }

        /// The repo as it actually stands: the only releases carrying a
        /// manifest are pre-releases, because v0.1.0/v0.1.1 predate updater
        /// artifacts. This is the exact shape that made the old static
        /// `releases/latest/download/latest.json` 404 for every default-
        /// channel user.
        fn real_world() -> Vec<GhRelease> {
            vec![
                rel("v0.1.2-2", true, true),
                rel("dev", true, true),
                rel("v0.1.2-1", true, true),
                rel("v0.1.1", false, false),
                rel("v0.1.0", false, false),
            ]
        }

        #[test]
        fn stable_refuses_a_full_release_that_has_no_manifest() {
            // Rather than picking v0.1.1 and 404ing on a manifest it does
            // not have, stable reports that there is nothing installable.
            assert!(pick_release(&real_world(), true).is_none());
        }

        #[test]
        fn latest_picks_the_newest_prerelease_with_a_manifest() {
            let releases = real_world();
            let best = pick_release(&releases, false).expect("a pre-release has a manifest");
            assert_eq!(best.tag_name, "v0.1.2-2");
        }

        /// `dev` is not a parseable version, so it must never be selected by
        /// version comparison -- that channel has its own static URL.
        #[test]
        fn the_rolling_dev_tag_is_never_picked_by_version() {
            let releases = vec![rel("dev", true, true)];
            assert!(pick_release(&releases, false).is_none());
        }

        #[test]
        fn stable_picks_the_newest_full_release_that_has_a_manifest() {
            let releases = vec![
                rel("v0.2.0", true, true),   // newer, but a pre-release
                rel("v0.1.3", false, false), // full, but no manifest
                rel("v0.1.2", false, true),  // <- newest installable full release
                rel("v0.1.1", false, true),
            ];
            let best = pick_release(&releases, true).expect("v0.1.2 is installable");
            assert_eq!(best.tag_name, "v0.1.2");
            // ...while `latest` still prefers the newer pre-release.
            assert_eq!(pick_release(&releases, false).unwrap().tag_name, "v0.2.0");
        }

        #[test]
        fn drafts_are_ignored_on_both_channels() {
            let mut draft = rel("v9.9.9", false, true);
            draft.draft = true;
            let releases = vec![draft, rel("v0.1.2", false, true)];
            assert_eq!(pick_release(&releases, true).unwrap().tag_name, "v0.1.2");
            assert_eq!(pick_release(&releases, false).unwrap().tag_name, "v0.1.2");
        }
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
        // stamped as `BASE+<count>.<short_sha>` (build-dev.yml). Per
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

        // Dev -> dev, the case `<count>` exists to order. build-dev.yml
        // stamps it as the commits `main` has advanced past BASE's tag, so
        // it increments with every merge and is the FIRST build-metadata
        // identifier precisely so it decides here -- note the SHAs are
        // chosen so a raw string comparison would order these backwards.
        #[test]
        fn strict_mode_offers_a_newer_dev_build_of_the_same_base() {
            let current = Version::parse("1.5.0+7.9f8e7d6").unwrap();
            let release = Version::parse("1.5.0+8.1a2b3c4").unwrap();
            assert!(should_offer_update(&current, &release, false));
        }

        #[test]
        fn strict_mode_refuses_an_older_dev_build_of_the_same_base() {
            let current = Version::parse("1.5.0+8.1a2b3c4").unwrap();
            let release = Version::parse("1.5.0+7.9f8e7d6").unwrap();
            assert!(!should_offer_update(&current, &release, false));
        }

        // The counter RESTARTS at each new release, so a dev build off a
        // fresh base carries a much SMALLER count than the one the user is
        // running. The base must still win, or every dev client would be
        // stranded on the old base the moment a release was cut. A count of
        // 0 is reachable (release tagged at `main`'s head, then a manual
        // build before the next merge), so test the extreme.
        #[test]
        fn a_new_base_outranks_a_higher_count_on_the_old_base() {
            let current = Version::parse("1.5.0+42.abc1234").unwrap();
            for release in ["1.6.0+0.def5678", "1.6.0+1.def5678"] {
                let release = Version::parse(release).unwrap();
                assert!(should_offer_update(&current, &release, false));
            }
        }

        // Same, across the pre-release -> release boundary: dev builds are
        // cut off pre-release bases too (e.g. "0.1.2-2"), and "0.1.3" must
        // still outrank them however far the old counter had climbed.
        #[test]
        fn a_new_base_outranks_a_dev_build_of_a_prerelease_base() {
            let current = Version::parse("0.1.2-2+99.abc1234").unwrap();
            let release = Version::parse("0.1.3+0.def5678").unwrap();
            assert!(should_offer_update(&current, &release, false));
        }
    }
}
