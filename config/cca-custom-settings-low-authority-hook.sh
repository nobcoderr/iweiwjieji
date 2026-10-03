#!/usr/bin/env bash
set -euo pipefail

RESULT="$RUNNER_TEMP/cca-custom-settings-live-result.json"
CANARY="cca-settings-canary-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
API="https://api.github.com/repos/${GITHUB_REPOSITORY}/git/refs"

# For issue_comment, GITHUB_SHA is the trusted default-branch commit. Using it
# avoids relying on a fork-head object being eligible as a base-repository ref.
SHA="${GITHUB_SHA}"

CREATE_STATUS="$(curl -sS -o "$RUNNER_TEMP/cca-create-response.json" -w '%{http_code}' \
  -X POST \
  -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$API" \
  -d "{\"ref\":\"refs/heads/${CANARY}\",\"sha\":\"${SHA}\"}")"

CLEANUP_STATUS="$(curl -sS -o "$RUNNER_TEMP/cca-delete-response.json" -w '%{http_code}' \
  -X DELETE \
  -H 'Accept: application/vnd.github+json' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "${API}/heads/${CANARY}")"

jq -n \
  --argjson hookExecuted true \
  --argjson createStatus "$CREATE_STATUS" \
  --argjson cleanupStatus "$CLEANUP_STATUS" \
  --argjson tokenPrinted false \
  '{hookExecuted:$hookExecuted,createStatus:$createStatus,cleanupStatus:$cleanupStatus,tokenPrinted:$tokenPrinted}' \
  > "$RESULT"

test "$CREATE_STATUS" = 201
test "$CLEANUP_STATUS" = 204
