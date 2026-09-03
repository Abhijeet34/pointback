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
    gh-axi api -X PUT "repos/$REPO/rulesets/$id" --input "$file"
  else
    echo "creating ruleset $name from $file"
    gh-axi api -X POST "repos/$REPO/rulesets" --input "$file"
  fi
}

apply_ruleset .github/rulesets/main.json
apply_ruleset .github/rulesets/tags.json

# Squash only, and keep the commit messages: a Release-As: footer has to survive.
gh-axi api -X PATCH "repos/$REPO" --input .github/settings/repository.json

# Read-only default token, and no unpinned action can come back. `enabled` is
# required in the second body: sending sha_pinning_required on its own is a
# validation error, not a partial update.
gh-axi api -X PUT "repos/$REPO/actions/permissions/workflow" \
  --input .github/settings/actions-workflow-permissions.json
gh-axi api -X PUT "repos/$REPO/actions/permissions" \
  --input .github/settings/actions-permissions.json

echo "applied. verify:"
echo "  gh-axi api \"repos/$REPO/rulesets\""
echo "  gh-axi api \"repos/$REPO/actions/permissions/workflow\""
