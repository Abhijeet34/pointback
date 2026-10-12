#!/bin/sh
# Applies the repository settings that are not files, from the files that
# describe them. Idempotent: a ruleset whose name already exists is updated in
# place rather than duplicated, which is what makes this safe to re-run after
# editing one of the JSON files.
#
# Usage: scripts/apply-repo-settings.sh OWNER/REPO
#
# docs/GIT-WORKFLOW.md, "Applying the settings that are not files", carries the
# reasoning; this file carries the commands so nobody retypes them.
#
# Writes go through plain `gh api`: `gh-axi api` has no -X and no --input, so it
# refused the first write with VALIDATION_ERROR and nothing was ever applied.
set -eu

REPO="${1:?usage: apply-repo-settings.sh OWNER/REPO}"
cd "$(dirname "$0")/.."

apply_ruleset() {
  file="$1"
  name=$(node -p "JSON.parse(require('fs').readFileSync('$file','utf8')).name")
  # A name that matches nothing leaves the tool printing an empty-body notice
  # rather than nothing at all, so the id is taken only if it is all digits.
  id=$(gh-axi api "repos/$REPO/rulesets" --jq \
    ".[] | select(.name == \"$name\") | .id" | tr -d ' ' | grep -E '^[0-9]+$' || true)
  if [ -n "$id" ]; then
    echo "updating ruleset $name ($id) from $file"
    gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file"
  else
    echo "creating ruleset $name from $file"
    gh api -X POST "repos/$REPO/rulesets" --input "$file"
  fi
}

apply_ruleset .github/rulesets/main.json
apply_ruleset .github/rulesets/tags.json

# Squash only, and keep the commit messages: a Release-As: footer has to survive.
gh api -X PATCH "repos/$REPO" --input .github/settings/repository.json

# Read-only default token, and no unpinned action can come back. `enabled` is
# required in the second body: sending sha_pinning_required on its own is a
# validation error, not a partial update.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  --input .github/settings/actions-workflow-permissions.json
gh api -X PUT "repos/$REPO/actions/permissions" \
  --input .github/settings/actions-permissions.json

# The policy that parks the release pull request's CI at `action_required`. It
# carries the live value, the strictest one, so applying never loosens it; no
# value is known to lift the parking (docs/GIT-WORKFLOW.md, "Releasing").
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  --input .github/settings/actions-fork-pr-contributor-approval.json

echo "applied. verify:"
echo "  gh-axi api \"repos/$REPO/rulesets\""
echo "  gh-axi api \"repos/$REPO/actions/permissions/workflow\""
echo "  gh-axi api \"repos/$REPO/actions/permissions/fork-pr-contributor-approval\""
