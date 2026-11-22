# Windows code signing

Without a signature, the Windows installers trip SmartScreen ("Windows protected
your PC") and show "Unknown publisher" in the UAC prompt. The desktop build signs
them with **Azure Artifact Signing** (formerly Trusted Signing). It is
**keyless**: GitHub Actions authenticates to Azure with its own OIDC token,
so no certificate file or client secret exists anywhere to leak or rotate.

Signing is **opt-in**. Until the `ARTIFACT_SIGNING_PROFILE` variable exists, both
`build.yml` and `build-dev.yml` ship unsigned exactly as before, with a workflow
notice saying so.

| Piece | Where |
|---|---|
| Azure tenant | `talmotalmolab.onmicrosoft.com` (the lab's talmolab.org Microsoft account) |
| Subscription | `SLEAP-CodeSigning` (`7a2efab6-399f-46c3-9e7a-81395d2838fe`) |
| Artifact Signing account | `sleap-signing` in `rg-sleap-codesigning`, West US 2, Basic tier |
| Endpoint | `https://wus2.codesigning.azure.net/` |
| Certificate profile | `sleap-public` (Public Trust), once identity validation passes |
| Entra app GitHub signs in as | `sleap-app-github-artifact-signing` |
| Trust | federated credential, subject `repo:talmolab/sleap-app:environment:code-signing` |
| CI config | variables on the GitHub `code-signing` environment |
| CI logic | `scripts/windows-signing.ps1` (`configure` / `sign` / `verify`) |

## How it works in CI

1. **Configure Windows code signing** runs `windows-signing.ps1 configure`. If
   `ARTIFACT_SIGNING_PROFILE` is unset, it records `SLEAP_WINDOWS_SIGNING=unsigned`
   and stops. Otherwise it:
   - downloads pinned `signtool` (`Microsoft.Windows.SDK.BuildTools`) and the
     Artifact Signing dlib (`Microsoft.ArtifactSigning.Client`) from NuGet;
   - writes the dlib's `metadata.json`;
   - writes a Tauri config overlay whose `bundle.windows.signCommand` calls back
     into the script;
   - signs a throwaway exe end to end. A broken setup fails here in seconds,
     not after the 15-minute Rust build.
2. **Build Tauri app** gets `--config <overlay>`. Tauri invokes
   `windows-signing.ps1 sign <file>` on every binary it ships: the app exe, the
   ffmpeg/ffprobe sidecars, the NSIS installer and its uninstaller, and the MSI.
   Signing happens inside the bundler, so the updater's minisign `.sig` is
   computed over the signed installer. Signing afterwards would invalidate every
   updater signature.
3. **Verify Windows code signature** asserts every binary is `Valid` **and
   timestamped**. Artifact Signing certificates live only three days. Without
   the timestamp, a signature stops validating almost immediately.

### Why fetch a new OIDC token for every file

The dlib authenticates through `DefaultAzureCredential`, which the script
restricts to `WorkloadIdentityCredential`. That credential reads a GitHub OIDC
token from `AZURE_FEDERATED_TOKEN_FILE`, and GitHub's tokens are short-lived.
One fetched before the Rust build could expire before bundling starts, so
`sign` writes a new one before every signature. This is also why there is no
`azure/login` step: its session is created at login time and can go stale the
same way.

### Why a GitHub environment

The federated credential has to match the token's `sub` claim exactly. A
ref-based subject differs for every release tag (`ref:refs/tags/v0.1.3`, …), so
it would need a new Azure credential per release. With `environment:
code-signing` on the build job, the subject is the same for tag releases, branch
dispatches and the nightly. **Do not add required reviewers** to that
environment, or the nightly dev build will block waiting for an approval.

## Setup

### 1. Identity validation (the person doing it, once)

In the portal, open **sleap-signing → Identity validations → New identity**. Choose:

- **Public** trust (Private trust is not trusted by SmartScreen).
- **Individual** puts your legal name on the certificate. **Organization** puts
  the organization's name on it, but needs the organization's registration
  documents.

After you submit, Microsoft emails a link to verify your government ID through
Microsoft Entra Verified ID (Authenticator app). **Complete it within the
window.** The first attempt (Sep 2026) failed only because that email ("Action
required: Complete your Artifact Signing identity validation") was never acted
on, and it expired to *Failed* about two weeks later. Enter the name and address
exactly as they appear on the ID.

### 2. Certificate profile

Once validation shows **Completed**, go to **Certificate profiles → Create →
Public Trust**. Name it `sleap-public` and select the validated identity.

### 3. Azure + GitHub wiring

```bash
az login --tenant talmotalmolab.onmicrosoft.com
bash scripts/setup-windows-signing.sh
```

The script is idempotent. It creates the Entra app and service principal, the
federated credential, and the **Artifact Signing Certificate Profile Signer**
role assignment on the account, then the `code-signing` environment and its
variables. `ARTIFACT_SIGNING_PROFILE` is set only if the profile already exists,
so running it early is harmless. Re-run it after step 2 to switch signing on.

### 4. Confirm

```bash
gh workflow run build.yml --ref main
```

In the Windows leg, check that **Configure Windows code signing** reports
"Windows code signing enabled" and that **Verify Windows code signature** lists
every binary as `ok`.

## Troubleshooting

- **`AADSTS70021: No matching federated identity record`.** The token's subject
  is not `repo:talmolab/sleap-app:environment:code-signing`. Usually the job is
  missing `environment: code-signing`, or the repo has a customized OIDC subject
  template.
- **`403` from the signing endpoint.** The role assignment is missing or still
  propagating (allow a few minutes). It could also be an endpoint/region
  mismatch: the endpoint must be the account's region (`wus2`).
- **`GitHub OIDC is unavailable`.** The job lost `permissions: id-token: write`.
- **Signed but not timestamped.** `timestamp.acs.microsoft.com` was
  unreachable. The `sign` step retries 3× and the verify step refuses the build.
- **Turning signing off in an emergency.** Delete the `ARTIFACT_SIGNING_PROFILE`
  variable. Builds go back to unsigned with no code change.
