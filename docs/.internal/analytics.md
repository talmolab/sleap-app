# Usage analytics: the map

How SLEAP App reports usage, across the three repositories involved. This is a
prototype; the last section lists what is deliberately not done yet.

User-facing description of the same thing: [`docs/usage-data.md`](../usage-data.md).

## The three repositories

```
 talmolab/sleap-app                talmolab/sleap-analytics-service        talmolab/sleap-analytics
 (this repo)                       analytics.sleap.ai, Cloud Run            nightly job -> stats.sleap.ai

 src/lib/analytics/                                                         check_stats.py
   track() / count()               POST /v2/events ──> event_batches ────>  app_stats.py ──> docs/app.json
        │                              ▲   (new)        (Firestore)                              │
        ▼                              │                                                         ▼
   AnalyticsClient ── web: fetch ──────┤                                                   docs/index.html
        │                              │                                                   "SLEAP App" section
        └─ desktop: analytics_post ────┤
           (src-tauri/src/analytics.rs)│
                                       ▼
                                   POST /ping ───────> pings ──────────────>  check_stats.py ──> summary.json
                                   (2022, frozen)      (Firestore)            (splits out product = sleap-app)
```

## What existed before

`POST /ping` takes `{sleap_version, python_version, platform, …}` from the Qt
GUI at launch and stores an eleven-key document. Its contract is frozen:
thousands of installed SLEAP versions post to it and cannot be upgraded. A user
is counted as `ip + platform`. It answers no CORS preflight, so a browser
cannot reach it.

That is enough to count launches by version. It cannot say what breaks, for
whom, or what anyone does after launch, and half of this app's users (the web
build) cannot reach it at all.

## What this adds

### 1. A client in the app (`src/lib/analytics/`)

| File | Role |
|---|---|
| `index.ts` | The leaf API the app calls: `track`, `countMenu`, `countCommand`, `reportError`. No-ops until a client is installed. |
| `events.ts` | **The event catalog.** Every event and property, typed. If it is not here it cannot be sent. |
| `protocol.ts` | Wire types, limits, and the pure sanitizers: `scrubText` (removes paths, filenames, URLs, emails), `errorFingerprint`, `bucket`, `buildLegacyPing`. |
| `client.ts` | Collect → seal to `localStorage` → deliver at least once. Retry, drop, fallback. All effects injected. |
| `consent.ts` | The two gates: the user's setting, and whether this build reports at all. |
| `context.ts` | The machine/build description sent with every batch. |
| `transport.ts` | Web: `fetch`. Desktop: the native `analytics_post` command. |
| `instrument.ts` | Store watchers that turn app activity into events. |
| `init.ts` | Wires all of the above; shows the first-run notice. Called once from `main.tsx`. |

Instrumentation points, chosen so that new features are covered without
anyone remembering to add a call:

- **Menus**: `buildAppMenu` wraps every node's `run`, so the menu bar, the
  native menu and Search Menus are all counted by stable menu id.
- **Commands**: `CommandContext.execute` counts every command by name, which
  also covers shortcuts and canvas gestures.
- **Runs**: `watchRun` observes the `status` field of the training and
  inference stores. Those stores do not know analytics exists.
- **Projects**: a new `labels` reference in the app store (assigned only by
  `setLabels`) means a project was opened; it is measured a few seconds later,
  off the load path, and reported in buckets.
- **Errors**: `window` `error` / `unhandledrejection`, and the React error
  boundary.

### 2. A second endpoint in the service (`POST /v2/events`)

One request carries one batch: identity (product, version, a random install
id, a session id), a flat `context`, and up to 100 events. It is stored as one
document in a new `event_batches` collection. `/ping` is untouched.

The properties that matter, each explained at length in that repo's
`app/events.py`:

- Strict envelope, sanitized contents: a bad property is dropped and counted,
  never a reason to reject the batch.
- Event names are not an enum. A new event needs no service deploy.
- It stores a `/24` or `/48` network prefix, not the client address.
- CORS only on `/v2/`, with an origin allow-list, and it insists on
  `application/json` so the preflight cannot be skipped.

### 3. A reader in the reporting repo (`app_stats.py`)

Reads `event_batches`, drops duplicate deliveries by `batch_id`, explodes
batches into events and writes `docs/app.json`: installs and sessions over
time, versions, platforms, feature usage, run outcomes, top errors, and the
onboarding funnel. `check_stats.py` also learns to recognize `/ping` rows whose
`sleap_version` starts with `sleap-app/` and report them separately.

## Compatibility with the service as deployed today

The client always tries `/v2/events` first. A service that predates it answers
`404`, and then:

- **Desktop** sends one `/ping`, from native code, shaped to pass that
  service's checks: all five watched fields present as strings,
  `sleap_version: "sleap-app/<version>"`, `tf_version: "N/A"`, `conda_env: ""`,
  and a `platform.platform()`-style string. The prefix keeps the row out of the
  Qt GUI's version-adoption chart (which extracts `^\d+\.\d+`) while it still
  counts as a launch.
- **Web** sends nothing. It cannot reach `/ping`, by that service's design.

The rest of that session collects nothing, and the next launch asks again. So
the app needs no release, flag or config change on the day the service is
upgraded: the same build starts delivering events.

## Rollout order

1. **Reporting repo first.** `app_stats.py` produces an empty `app.json` when
   `event_batches` does not exist, and the `sleap-app/` split in
   `check_stats.py` is a no-op until such rows arrive.
2. **Then the app.** Desktop launches start appearing as `/ping` rows.
3. **Then the service.** From that deploy on, both runtimes deliver events and
   desktop stops sending `/ping`.

Doing 3 before 1 loses nothing (batches are stored), but the dashboard shows
desktop launches dropping to zero until the reader ships.

## Privacy rules

These are enforced in code and pinned by tests; see `tests/unit/analytics*.test.ts`.

- Off in dev builds and automated browsers, whatever the setting says.
- On by default, **after** a first-run notice. Until the notice has been seen,
  events are held in memory: nothing is written to `localStorage` or sent.
- A browser sending Do Not Track or Global Privacy Control starts out off.
- Turning it off discards everything held and stored, immediately.
- The choice survives Reset Preferences to Defaults.
- No free text leaves the machine unscrubbed. No names of files, videos,
  projects, nodes or tracks appear in any event; menu radios are counted by id,
  never by chosen value (the trail-node radio's values are node names).
- Project sizes are buckets.

## For support

- **Help ▸ About** shows the install id as a **Support ID**. It is the same id
  in a diagnostics bundle (`meta.installId`) and in every batch
  (`install_id`), so a bug report, a bundle and the server-side events can be
  joined by hand.
- Each `error` event carries a fingerprint (`fp`), the scrubbed message, the
  top stack frames as `function@chunk.js:line:col`, and the last command that
  ran. The fingerprint ignores digits and file names, so one bug groups across
  users and versions.
- `context` carries the OS, WebView, GPU, sleap-nn, uv and Python versions:
  the first five questions of most support threads.
- `session_start.prior_crash` gives a crash rate per version.

## Testing it locally

```bash
# 1. the service, with an in-memory store (PYTEST_VERSION selects MockFirestore)
cd ../sleap-analytics-service && PYTEST_VERSION=1 .venv/bin/uvicorn app.main:app --port 8099

# 2. the web app, pointed at it
VITE_ANALYTICS_URL=http://127.0.0.1:8099 bun run dev
#    then, in the browser console (dev builds never report otherwise):
localStorage.setItem("sleap.analytics.debug", "1"); location.reload();

# 2'. or the desktop app
SLEAP_ANALYTICS_URL=http://127.0.0.1:8099 bun run tauri:dev
```

With the debug flag set, every request and its batch is logged to the console
as `[analytics] POST /v2/events → 200 (ok)`.

## Not done yet

- **No rate limiting** on `/v2/events`. The 64 KiB body cap bounds a request,
  not the number of requests.
- **No retention policy** for `event_batches`. Decide one (a Firestore TTL on
  `received_at` is the simple option) before the collection is large.
- **No way to delete one install's data on request.** The Support ID makes it
  possible to find; nothing automates it.
- **The reader scans a trailing window nightly.** Fine at this scale; it should
  become incremental before the collection reaches millions of documents.
- **The desktop transport has no on-quit flush.** A batch sealed at quit is
  delivered at the next launch.
- **Legal review.** The notice and `docs/usage-data.md` describe what is
  collected accurately, but nobody has checked them against institutional or
  GDPR requirements.
- **Instrumentation is shallow on purpose.** Panels opened, export formats,
  remote-compute (Connect) usage and model types are the obvious next events;
  add them to `events.ts` and `docs/usage-data.md` together.
- **`deploy.yml` in the service has no production smoke for `/v2/events`.**
  The image smoke test covers it against the Firestore emulator only.
