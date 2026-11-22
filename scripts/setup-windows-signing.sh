#!/usr/bin/env bash
# One-time (and safely re-runnable) setup of keyless Windows code signing for
# the desktop build: Azure Artifact Signing, trusted via GitHub OIDC.
#
# What it does, each step skipped if already done:
#   1. Creates the Entra app + service principal GitHub Actions signs in as.
#   2. Adds a federated credential trusting this repo's `code-signing`
#      environment (no client secret is ever created).
#   3. Grants it "Artifact Signing Certificate Profile Signer" on the account.
#   4. Creates the GitHub `code-signing` environment and sets its variables.
#      ARTIFACT_SIGNING_PROFILE -- the switch that turns signing on in CI -- is
#      set only once the certificate profile actually exists, so running this
#      before identity validation has passed cannot break the builds.
#
# Prerequisites:
#   az login --tenant talmotalmolab.onmicrosoft.com   # an Owner of the subscription
#   gh auth login                                     # admin on talmolab/sleap-app
#
# Usage:
#   bash scripts/setup-windows-signing.sh            # everything that can be done now
#   PROFILE=sleap-public bash scripts/setup-windows-signing.sh   # other profile name
#
# See docs/.internal/windows-code-signing.md.
set -euo pipefail

SUBSCRIPTION="${SUBSCRIPTION:-7a2efab6-399f-46c3-9e7a-81395d2838fe}"   # SLEAP-CodeSigning
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-sleap-codesigning}"
ACCOUNT="${ACCOUNT:-sleap-signing}"
ENDPOINT="${ENDPOINT:-https://wus2.codesigning.azure.net/}"           # West US 2
PROFILE="${PROFILE:-sleap-public}"
REPO="${REPO:-talmolab/sleap-app}"
GH_ENVIRONMENT="${GH_ENVIRONMENT:-code-signing}"
APP_NAME="${APP_NAME:-sleap-app-github-artifact-signing}"

SUBJECT="repo:${REPO}:environment:${GH_ENVIRONMENT}"
ACCOUNT_SCOPE="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.CodeSigning/codeSigningAccounts/${ACCOUNT}"

say() { printf '\n==> %s\n' "$*"; }

az account set --subscription "$SUBSCRIPTION"
TENANT_ID="$(az account show --query tenantId -o tsv)"
say "Tenant $TENANT_ID, subscription $SUBSCRIPTION"
az resource show --ids "$ACCOUNT_SCOPE" --query name -o tsv >/dev/null \
  || { echo "Artifact Signing account not found: $ACCOUNT_SCOPE" >&2; exit 1; }

say "1. Entra app '$APP_NAME'"
APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [ -z "$APP_ID" ]; then
  APP_ID="$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
  echo "created app $APP_ID"
else
  echo "exists: $APP_ID"
fi
SP_ID="$(az ad sp list --filter "appId eq '$APP_ID'" --query '[0].id' -o tsv)"
if [ -z "$SP_ID" ]; then
  SP_ID="$(az ad sp create --id "$APP_ID" --query id -o tsv)"
  echo "created service principal $SP_ID"
else
  echo "service principal exists: $SP_ID"
fi

say "2. Federated credential for $SUBJECT"
if [ -n "$(az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$SUBJECT'].name" -o tsv)" ]; then
  echo "exists"
else
  az ad app federated-credential create --id "$APP_ID" --parameters "$(cat <<JSON
{
  "name": "github-${GH_ENVIRONMENT}",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "${SUBJECT}",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "GitHub Actions in ${REPO}, environment ${GH_ENVIRONMENT}"
}
JSON
)" --query name -o tsv
fi

say "3. Signer role on $ACCOUNT"
# The role was renamed with the product (Trusted Signing -> Artifact Signing);
# accept whichever name this tenant knows.
ROLE=""
for candidate in "Artifact Signing Certificate Profile Signer" "Trusted Signing Certificate Profile Signer"; do
  if [ -n "$(az role definition list --name "$candidate" --query '[0].name' -o tsv)" ]; then
    ROLE="$candidate"; break
  fi
done
[ -n "$ROLE" ] || { echo "no Certificate Profile Signer role definition found" >&2; exit 1; }
if [ -n "$(az role assignment list --assignee "$SP_ID" --scope "$ACCOUNT_SCOPE" --role "$ROLE" --query '[0].id' -o tsv)" ]; then
  echo "exists: $ROLE"
else
  az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
    --role "$ROLE" --scope "$ACCOUNT_SCOPE" --query id -o tsv
fi

say "4. GitHub environment '$GH_ENVIRONMENT' on $REPO"
gh api -X PUT "repos/${REPO}/environments/${GH_ENVIRONMENT}" --silent
gh variable set AZURE_CLIENT_ID           --repo "$REPO" --env "$GH_ENVIRONMENT" --body "$APP_ID"
gh variable set AZURE_TENANT_ID           --repo "$REPO" --env "$GH_ENVIRONMENT" --body "$TENANT_ID"
gh variable set ARTIFACT_SIGNING_ENDPOINT --repo "$REPO" --env "$GH_ENVIRONMENT" --body "$ENDPOINT"
gh variable set ARTIFACT_SIGNING_ACCOUNT  --repo "$REPO" --env "$GH_ENVIRONMENT" --body "$ACCOUNT"

if az resource show --ids "${ACCOUNT_SCOPE}/certificateProfiles/${PROFILE}" --query name -o tsv >/dev/null 2>&1; then
  gh variable set ARTIFACT_SIGNING_PROFILE --repo "$REPO" --env "$GH_ENVIRONMENT" --body "$PROFILE"
  say "Done. Signing is ON: the next build signs with profile '$PROFILE'."
else
  say "Done, but signing stays OFF: certificate profile '$PROFILE' does not exist yet."
  echo "Finish identity validation, create a Public Trust profile named '$PROFILE'"
  echo "in the portal (sleap-signing -> Certificate profiles), then re-run this script."
fi
