# macOS code signing and notarization

The desktop build works with no Apple account at all: `bundle.macOS.signingIdentity`
is `"-"` in `src-tauri/tauri.conf.json`, so Tauri ad-hoc signs the bundle. That is
what keeps macOS from reporting **"SLEAP is damaged and can't be opened"**, which is
the error for an *invalid* signature — not for an unsigned one.

Ad-hoc signing is not enough to hand someone a `.dmg`, though. A disk image that
arrives through a browser (or Slack, email, AirDrop) carries
`com.apple.quarantine`, the tag propagates to the app dragged out of it, and
Gatekeeper blocks any un-notarized app that carries it. `scripts/install.sh` works
around that by fetching with `curl`, which never sets the tag.

**Notarization is the only way a browser-downloaded `.dmg` opens with no prompt.**
This page sets that up. It requires a paid Apple Developer Program membership
($99/yr).

## What CI does with what

`build.yml`'s `Configure macOS code signing` step picks a mode from which secrets
are present, and the `Verify macOS code signature` step then *asserts* that mode —
so a certificate that silently fails to load fails the build instead of quietly
shipping an ad-hoc release.

| Secrets present | Mode | Browser-downloaded `.dmg` |
|---|---|---|
| none | `adhoc` | blocked; needs `install.sh` or `xattr -dr` |
| cert + identity | `developer-id` | still blocked (signed but not notarized) |
| cert + identity + notary creds | `developer-id-notarized` | **opens with no prompt** |

There is no half-configured state that silently degrades: signing with a
certificate but no notary credentials emits a workflow warning.

## Secrets to create

Seven repository secrets, all under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of your Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an **app-specific password**, not your account password |
| `APPLE_TEAM_ID` | your 10-character Team ID |

(`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` already
exist and are unrelated — those sign the *updater* manifest, not the app.)

## Step 1 — create the Developer ID Application certificate

Only the **Account Holder** can create a Developer ID certificate on an
organization account. There is a hard limit of 5 per account, each valid 5 years,
so export the `.p12` and keep it somewhere safe — losing it means burning one of
the five.

1. **Generate a signing request.** Open *Keychain Access* → menu *Keychain Access*
   → *Certificate Assistant* → *Request a Certificate From a Certificate
   Authority*. Enter your email and name, choose **Saved to disk**, and save
   `CertificateSigningRequest.certSigningRequest`.

2. **Issue the certificate.** Go to
   [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
   → **+** → **Developer ID Application** → *Profile Type: G2 Sub-CA* → upload the
   CSR → **Download** the resulting `developerID_application.cer`.

3. **Install it.** Double-click the `.cer`. It lands in your login keychain, paired
   with the private key the CSR created.

4. **Confirm macOS sees a usable identity:**

   ```bash
   security find-identity -v -p codesigning
   ```

   You want a line like
   `1) ABC123... "Developer ID Application: Talmo Pereira (A1B2C3D4E5)"`.
   The quoted string is exactly the `APPLE_SIGNING_IDENTITY` secret, and the
   parenthesized suffix is your `APPLE_TEAM_ID`.

   > If this prints `0 valid identities found`, the intermediate is missing.
   > Download **Developer ID — G2** from
   > [apple.com/certificateauthority](https://www.apple.com/certificateauthority/)
   > and double-click it.

5. **Export for CI.** In *Keychain Access*, find the
   `Developer ID Application: ...` entry, right-click → **Export**, choose
   *Personal Information Exchange (.p12)*, and set a password. Then:

   ```bash
   base64 -i Certificates.p12 | pbcopy   # -> APPLE_CERTIFICATE
   ```

   macOS's `base64` emits a single line, which is what the workflow expects.

## Step 2 — create an app-specific password for notarization

Notarization authenticates separately from signing, and it will **not** accept
your account password.

1. Go to [account.apple.com](https://account.apple.com) → *Sign-In and Security* →
   *App-Specific Passwords* → **+**.
2. Name it something like `sleap-app notarytool`.
3. Copy the `xxxx-xxxx-xxxx-xxxx` value → `APPLE_PASSWORD`.

## Step 3 — set the secrets

```bash
gh secret set APPLE_CERTIFICATE < <(base64 -i Certificates.p12)
gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY   # Developer ID Application: NAME (TEAMID)
gh secret set APPLE_ID                 # your Apple ID email
gh secret set APPLE_PASSWORD           # the app-specific password
gh secret set APPLE_TEAM_ID            # the 10-character team id
```

Each bare `gh secret set` prompts for the value without echoing it.

## Step 4 — verify

```bash
gh workflow run build.yml --ref main
```

In the macOS job, look for:

- `Configure macOS code signing` → `Developer ID signing + notarization enabled.`
- `Notarize and staple the .dmg` → `Stapled SLEAP_<version>_universal.dmg`
- `Verify macOS code signature` → `Notarized, stapled, and accepted by Gatekeeper.`

Then confirm on a real machine, the way a tester would — download the `.dmg` in a
**browser** so it gets quarantined, and check that Gatekeeper accepts it anyway:

```bash
xattr -p com.apple.quarantine ~/Downloads/SLEAP_*.dmg   # tag IS present
spctl -a -vvv -t open --context context:primary-signature ~/Downloads/SLEAP_*.dmg
# -> accepted, source=Notarized Developer ID
```

Dragging the app to `/Applications` should then launch with no dialog at all.

## Notes and failure modes

- **Notarization is asynchronous.** `notarytool submit --wait` usually returns in
  1–5 minutes but Apple publishes no SLA; the workflow caps it at 30 minutes.
- **Stapling matters.** Without a stapled ticket, a user who is offline or behind a
  firewall that blocks Apple's OCSP responder still gets prompted. CI runs
  `stapler validate` on both the `.app` and the `.dmg` to catch that.
- **The hardened runtime is mandatory** for notarization to be accepted. Tauri
  enables it by default (`bundle.macOS.hardenedRuntime`), and the verify step
  asserts the `runtime` flag is present. If the app ever needs an exemption (JIT,
  loading unsigned plugins), add `bundle.macOS.entitlements` rather than turning
  the hardened runtime off.
- **`minimumSystemVersion` is `13.0`**, set because Vite's default browser target
  is `safari16.4` (macOS 13.3) and `SharedArrayBuffer` is load-bearing for the
  large-`.pkg.slp` path. Lowering it produces a build that installs on older macOS
  and then white-screens.
- **Certificate expiry is silent.** When the certificate lapses in 5 years, signing
  fails outright rather than degrading, and the verify step's mode assertion turns
  it into a clear error rather than an ad-hoc release.
- **Forks and PRs from forks get no secrets**, so they fall back to `adhoc` and
  still build. That is deliberate.

## Windows

Not set up, and not doing the same job. SmartScreen warnings are driven by
reputation, so only an EV certificate (hardware token, ~$300+/yr) removes them
outright; a standard code-signing certificate mostly just accrues reputation over
time. The NSIS installer is currently unsigned, and its warning has a
**More info → Run anyway**.
