# Git and delivery workflow

How a change reaches `main`, how a release is cut, and what happens when one has to be withdrawn.
Everything here is either in the repository or is a repository setting with a committed copy under `.github/rulesets/` or `.github/settings/`, so nothing load-bearing lives only in someone's memory of a settings page.

<!-- toc -->

- [Branching](#branching)
- [What protects main](#what-protects-main)
- [Signed commits](#signed-commits)
- [Secret scanning](#secret-scanning)
- [What a pull request costs](#what-a-pull-request-costs)
- [Versioning](#versioning)
- [Releasing](#releasing)
- [Publishing to npm](#publishing-to-npm)
- [Rolling back](#rolling-back)
- [Applying the settings that are not files](#applying-the-settings-that-are-not-files)
- [Known gaps](#known-gaps)

<!-- /toc -->

## Branching

Trunk-based, one trunk, short branches.
`main` is the only long-lived branch, every commit on it is releasable, and no branch lives long enough to need a merge strategy of its own.
Branch from `main`, name the branch for the change (`fix/poll-timeout`, `feat/annotation-anchors`), open a pull request, squash-merge it, delete the branch.

Squash is the only merge method the ruleset allows.
Two things depend on it: release-please derives the next version from the conventional-commit subjects that land on `main`, and a `Release-As:` footer in a squash body is how a version is set by hand when it has to be.
A merge commit or a rebase merge would let a `feat!:` from a work-in-progress commit land unsquashed and move the version for a reason nobody chose.

## What protects main

`.github/rulesets/main.json` is the branch ruleset, and `.github/rulesets/tags.json` protects the `v*` tag namespace.
Both are import-ready: GitHub's ruleset import accepts the same JSON that `gh api repos/OWNER/REPO/rulesets/ID` exports, so the file in the repository and the live setting are the same shape and can be diffed.

**Exactly one required status check: `checks`.**
It is the aggregate job at the bottom of `.github/workflows/ci.yml`, and every other job reaches branch protection through it and nowhere else.
That indirection is the point.
A required check is identified by its context name, so requiring `check`, `secret scan` and `dependency review` individually would freeze the job names, and every rename or path-scoping would need a branch-protection edit to match.
It also handles the case that a naive setup gets wrong: a job that skips itself by `if:` reports `skipped`, and a skipped required check is not a failing one, so a required check that can skip blocks nothing.
`checks` runs on `if: always()` and reads the results of its dependencies itself.

The other rules and why each is there:

| Rule                                                                  | What it stops                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `required_status_checks` on `checks`, strict                          | Merging a red branch, or a branch that has not been rebuilt against the current `main` |
| `pull_request`, `allowed_merge_methods: ["squash"]`                   | A merge or rebase merge, which would break version derivation                          |
| `required_signatures`                                                 | An unsigned commit, including one made through the web UI or the API                   |
| `deletion`, `non_fast_forward`                                        | Deleting `main`, and force-pushing over published history                              |
| Tag ruleset: `update`, `deletion` on `refs/tags/v*`, no bypass actors | Anyone, including automation, moving or deleting a release tag once it exists          |

**The tag ruleset has no `creation` rule, and that is measured rather than chosen.**
A `bypass_actors` entry for the GitHub Actions app (`Integration`, `actor_id` 15368, the id `GET /apps/github-actions` returns) is refused on this repository:

```
422 Validation Failed
Actor GitHub Actions integration must be part of the ruleset source or owner organization
```

There is no owner organization on a user-owned repository, so no app can be a bypass actor here.
Without a bypass, a `creation` rule blocks release automation too, and that was verified rather than assumed: a workflow calling `POST /repos/{owner}/{repo}/git/refs` with `GITHUB_TOKEN`, the same path release-please tags with, failed `422 Reference update failed` under a `creation` rule and succeeded under the ruleset as it now stands.
An unsatisfiable rule that freezes the first release is worse than no rule, so `creation` is out and the two rules that automation never needs stay in: once a `v*` tag exists, nobody moves or deletes it, not a person and not a workflow.
A person creating a stray `v*` tag by hand is the residual hole, and `scripts/release-preflight.js` is what stands in it.

`required_approving_review_count` is 0.
A single-maintainer repository gains nothing from self-approval, and the required check is what actually reads the change.

**Do not add a second required context.**
Anything worth blocking a merge belongs as a job inside `ci.yml`, wired into `checks`' `needs:` list.
A check that runs but is not required blocks nothing, and a required check that can skip is worse, because it looks like protection.

## Signed commits

The ruleset rejects unsigned commits, so a clone that cannot sign cannot merge.
Verify before starting work:

```sh
git config --get commit.gpgsign     # true
git config --get user.signingkey    # the key or its path
git log --show-signature -1
```

This applies to the web UI and the API as well, which sign with GitHub's own key, so a web edit is accepted and a rebase from an unconfigured clone is not.

## Secret scanning

The gate is `.githooks/pre-push`, which refuses a push before anything reaches the remote.
The rules are `.gitleaks.toml`.
**Both files are copies of one canonical gate maintained in a private upstream repository shared across its siblings, and are never hand-edited here.**
A change belongs upstream and reaches this tree as a re-sync.
The hook is also inert until the clone points at it, which no checkout does for you and which the sync does as its last step:

```sh
git config core.hooksPath .githooks
```

CI is the backstop, not the gate: the `secret scan` job in `ci.yml` re-reads the full history weekly, because history does not change between runs but gitleaks' rule set does.
It pins the SHA-256 of both synced files, so a drifted copy fails the job and the fix is to re-sync from upstream, never to edit the file.

That job is a local body rather than a call to `automation`'s `shared-secret-scan.yml`, which every private sibling uses.
GitHub's reusable-workflow access table permits a private caller to use a workflow from a private or a public repository and permits a **public** caller only a public one, so a public repository cannot reach a workflow in a private one.
The day `automation` is public, or this repository is private, replace the job with `uses: Abhijeet34/automation/.github/workflows/shared-secret-scan.yml@main` and delete the copy.
Until then the two digest pins are the only thing tying this body to the canonical rules, and drift in the body itself is detected by nothing.

## What a pull request costs

Nothing, while the repository is public.
GitHub bills standard hosted runners only for private repositories; public repositories use them free.
The matrix below is still Linux-only on `pull_request`, because `AGENTS.md` says so and because wall-clock and attention are billed even when minutes are not.

The private-repository counterfactual, at the rates measured on 2026-09-03 and recorded in the `lavish-release-devops-r2` design (Linux $0.006, Windows $0.010, macOS $0.062 per minute, every job rounded up to a whole minute):

| Event                         | Jobs                                                  | Billed Linux minutes | If private                        |
| ----------------------------- | ----------------------------------------------------- | -------------------- | --------------------------------- |
| Push to a pull request        | `check`, `secret scan`, `dependency review`, `checks` | 2 + 2 + 1 + 1 = 6    | $0.036                            |
| Merge to `main`               | `check`, `secret scan`, `checks`, `release-please`    | 2 + 2 + 1 + 1 = 6    | $0.036                            |
| Weekly `cross-platform`       | macOS 3, Windows 3, Linux 2                           | n/a                  | $0.186 + $0.030 + $0.012 = $0.228 |
| Release (on top of the merge) | `cross-platform`, `artifacts`, `publish`              | n/a                  | $0.228 + $0.006 + $0.006 = $0.240 |

The per-job minutes are an upper bound, not a measurement: the whole gate runs in 6.7 s locally with dependencies installed, so every job here is dominated by checkout and `npm ci` rather than by its own work, and the arithmetic is dominated by GitHub's per-job rounding.
Replace them with `started_at` to `completed_at` from the first ten runs.

Against the reference implementation's measured figures in section 5.1 of that design, $0.018 per pull request push and $0.100 per merge on a three-OS matrix: the pull request here costs twice as much because it runs three gates the reference splits across four separate workflows, and the merge costs a third as much because macOS and Windows have moved off the merge path to a weekly schedule and the release path.
The macOS leg is the whole difference.
It sat at exactly 60 seconds there, one second from doubling to $0.124, and it was 62 percent of that repository's merge cost on its own.

## Versioning

SemVer, derived by release-please from the conventional-commit subjects that land on `main`.
`release-please-config.json` sets `bump-minor-pre-major` and `bump-patch-for-minor-pre-major`, so below 1.0.0 a `fix:` and a `feat:` both bump the patch and a breaking change bumps the minor.
Nothing is a major bump before 1.0.0, deliberately: a 0.x line that hands out major versions has no way to say "this one is different".

**The line starts at `0.1.0`, and neither of those two flags is what puts it there.**
They govern a bump from an existing version; the first release is not a bump.
release-please 17.6.0 (the version bundled in `release-please-action` v5.0.0, `package-lock.json` at that tag) resolves the first release in `Strategy.buildNewVersion`: with no previous release it returns `initialReleaseVersion()`, which is `Version.parse('1.0.0')` unless `initial-version` is configured (`src/strategies/base.ts`, read 2026-09-03).
`initial-version: "0.1.0"` in `release-please-config.json` is that configuration, and it is inert from the second release onwards, when a previous release exists and the two bump flags take over.

`.release-please-manifest.json` stays at `0.0.0` until release-please writes to it, and that exact string is load-bearing.
`src/manifest.ts` backfills a synthetic previous release from the manifest for a package with no GitHub release, and skips the backfill when the manifest entry is `0.0.0`.
Seeding the manifest with `0.1.0` instead would take that backfill: release-please would treat `0.1.0` as already released, bump from it, and cut `0.1.1` as the first release, skipping `0.1.0` forever.
That is why the fix is `initial-version` and not a seeded manifest.

Both of those facts describe the window before the first release, and the test that pins them ends with it.
release-please writes `CHANGELOG.md`, the manifest and `package.json` in one commit, so the changelog existing is this tree saying the window has closed: from then on the manifest holds a released version and `0.0.0` is the wrong answer, not the load-bearing one.
`test/pipeline.test.js` skips that test once `CHANGELOG.md` exists, and says so in its output rather than passing silently.
Asserting it past the window is not hypothetical: it failed the release pull request's own diff, which is the one change that must move the manifest off the sentinel.

`1.0.0` is cut on purpose, by putting `Release-As: 1.0.0` in the squash body of a merged pull request.
From then on `feat:` is a minor and `!` is a major.

A tag is `v<version>` and nothing else.
`include-component-in-tag` is `false`, so a single-package repository does not carry a component prefix it has no use for.

**A release must never attach to a tag that already existed**, because GitHub reuses a tag without complaining and the release then points at a commit nobody reviewed.
Three things stand against it, in the order they take effect:

1. The tag ruleset: nobody can move or delete a `refs/tags/v*` once it exists, so the tag a release attaches to cannot be repointed underneath it. It cannot stop a stray tag being created, for the reason in "What protects main".
1. `scripts/release-preflight.js`, run by the `artifacts` job before anything is uploaded: it compares the commit the tag resolves to against the commit release-please reported releasing, and refuses when they differ. With `creation` unavailable, this is the load-bearing one.
1. `test/release-preflight.test.js`, which demonstrates that refusal rather than assuming it.

## Releasing

Merging any conventional commit to `main` starts `.github/workflows/release.yml`.

```text
squash-merge to main
  └─ release-please ── opens or updates "chore(main): release x.y.z"
                       (nothing else runs; the pull request accumulates changes)

merge the release pull request
  └─ release-please ── writes CHANGELOG.md and package.json, tags vX.Y.Z, creates the GitHub release
       ├─ cross-platform ── macOS, Windows and current-Node Linux, all green before anything ships
       ├─ artifacts ─────── preflight, npm pack, SBOM, build provenance, upload both to the release
       └─ publish ───────── only if the NPM_PUBLISH_ENABLED repository variable is "true"
```

`CHANGELOG.md` is release-please's file.
Nobody edits it by hand.
`.prettierignore` excludes it for that reason: it is generated markdown, not formatted source, and `format:check` reading it failed the release pull request before anyone could review the release.

**The release pull request's CI does not start on its own.**
It is opened by `github-actions[bot]`, and GitHub classifies a bot's pull request as an external contribution even when the branch is in this repository, so every run on it completes as `action_required` with no check runs at all.
That was measured rather than inferred: runs `33800809078`, `33801077938` and `33816315115` all ended `action_required` on branch `release-please--branches--main--components--pointback`, `GET /repos/OWNER/REPO/commits/<head sha>/check-runs` returned `total_count: 0`, and one `POST .../actions/runs/33816315115/approve` released it into a real run that reported four check runs and a verdict 26 seconds later.
`.github/settings/actions-fork-pr-contributor-approval.json` is the policy that does it, committed at GitHub's default so a change to it is visible in a diff; none of the three values that policy accepts is defined over bots, and the two community reports of this behaviour say loosening it does not exempt `github-actions[bot]`.

So a release costs one deliberate approval, from the pull request's Checks tab or from the command line:

```sh
gh-axi api -X POST "repos/OWNER/REPO/actions/runs/RUN_ID/approve"
```

The `checks` context then appears on the release pull request's head commit and the branch ruleset is satisfied in the ordinary way; nothing merges unchecked.
Removing that click means giving release automation a token identity that is not `github-actions[bot]` - a GitHub App installation token or a fine-grained PAT with `contents: write` and `pull-requests: write` - passed to `release-please-action` as `token:`.
That is a credential to store and rotate for one click a release, which is why it has not been done.

The `artifacts` job checks the tag out rather than `main`, so the tarball is packed from the tagged tree, and the `cross-platform` job it depends on runs on the release commit, which the preflight proves is the commit the tag names.
The SBOM comes from GitHub's dependency-graph export (`gh api repos/OWNER/REPO/dependency-graph/sbom`), which describes the manifests from the same data the pull request dependency review reads.
`actions/attest-build-provenance` signs the tarball, so the release asset is verifiable with `gh attestation verify` whether or not it was ever published to npm.

## Publishing to npm

Off.
The `publish` job runs only when the repository variable `NPM_PUBLISH_ENABLED` is exactly `true`, and that variable is now the whole switch.
With the variable unset the release ends at the tag, the GitHub release and its two assets, and the job is visibly skipped rather than quietly absent.
`package.json` used to hold a second refusal in `"private": true` and `"license": "UNLICENSED"`; both were dropped once the name was settled and the licence became Apache-2.0, so the variable stands alone.
`scripts/release-preflight.js --publishing` still refuses a publish with `private` true, with the licence absent or `UNLICENSED`, or with no `files` allowlist, which is what catches a regression to any of those rather than a first setup.

The mechanism, when it is turned on, is **npm trusted publishing over OIDC**.
No long-lived token is stored anywhere: the `publish` job asks GitHub for an OIDC token and npm trusts the claim, which names the owner, the repository and the workflow filename.
From npm's trusted-publishing documentation, read 2026-09-03:

- "Trusted publishing allows you to publish npm packages directly from your CI/CD workflows using OpenID Connect (OIDC) authentication, eliminating the need for long-lived npm tokens."
- "Trusted publishing requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher."
- "When you publish using trusted publishing from GitHub Actions or GitLab CI/CD, npm automatically generates and publishes provenance attestations for your package. This happens by default - you don't need to add the `--provenance` flag to your publish command."
- "Provenance generation is not currently supported for private repositories, even when publishing public packages."
- "If you encounter an 'Unable to authenticate' (ENEEDAUTH) error when publishing, first verify that the workflow filename matches exactly what you configured on npmjs.com, including the `.yml` extension."

So there is no `--provenance` flag in the publish command, and there should not be: it is redundant when the repository is public and it turns a provenance-ineligible publish into a failed release.
The workflow asserts the npm version itself, because an old npm fails with `ENEEDAUTH`, which reads like a misconfigured trusted publisher rather than an old client.

**The one thing OIDC cannot do is create the package.**
Trusted publishing is configured in a package's settings page on npmjs.com, and that page exists only for a package that has been published.
`npm/cli#8544`, "Allow publishing initial version with OIDC", is open on this point.
So the first publish of a name is a manual one, from a laptop, with `npm login` and 2FA, and every release after it comes from CI with no token anywhere.
Check the npmjs.com form at the time: if it offers a trusted publisher for a name that has never been published, skip the manual step.

If a token is ever genuinely required instead, it is a granular access token scoped to this package alone, read and write, at the shortest expiry npm offers, stored as the repository secret `NPM_TOKEN` and consumed as `NODE_AUTH_TOKEN`.
That is the fallback, not the plan.
Anyone holding such a token can publish any version of the package from anywhere until it expires or is revoked, with no claim to check.

## Rolling back

npm permits three things, in this order of preference.
None of them un-publishes what people already downloaded.

1. **Repoint `latest`**, seconds, reversible: `npm dist-tag add NAME@<previous> latest`.
   Every documented install path resolves `latest`, so this is the real rollback.
   It needs a write-capable session, which means `npm login` with 2FA from the maintainer's laptop.
1. **Deprecate the bad version**, minutes, reversible: `npm deprecate NAME@X.Y.Z "<why, and which version to use>"`, undone with an empty message.
   Installers see the message and nothing breaks.
1. **Unpublish**, only inside the window npm allows.
   npm's policy: a package can be unpublished "anytime within the first 72 hours after publishing" as long as nothing in the registry depends on it, and after that only if nothing depends on it, it "had less than 300 downloads over the last week", and it "has a single owner/maintainer".
   And: "Once `package@version` has been used, you can never use it again."

**A burned version number is permanent, so the hotfix is always a new patch.**
Land a `fix:` through the ordinary gate, merge it, merge the release pull request release-please opens, and the pipeline publishes `X.Y.(Z+1)`.
Two merges, no manual steps.

On the GitHub side a release can be marked pre-release or deleted, but the tag stays: the tag ruleset means no person can move or delete it, which is deliberate, because a published version's provenance attestation references that commit.

## Applying the settings that are not files

These settings are applied; one command re-applies them, which is also how a setting changed in the web UI is put back.
Everything it sends is a setting, not a credential, and every value it sends is a file in this repository: `.github/rulesets/main.json`, `.github/rulesets/tags.json`, and the three exports under `.github/settings/`.

```sh
REPO=OWNER/pointback
scripts/apply-repo-settings.sh "$REPO"

# Install the secret-scan gate in the clone. CI checks the file contents; only
# this points git at the hook, which no checkout carries.
git config core.hooksPath .githooks
```

It is idempotent: a ruleset whose name already exists is updated in place, so re-run it after editing any of those files rather than deleting and recreating a ruleset.
Two things it encodes that cost a round to find out. A ruleset is created with `POST /repos/{owner}/{repo}/rulesets` but updated with `PUT .../rulesets/{id}`, and the id is not in the file, so the script looks it up by name.
And `PUT /repos/{owner}/{repo}/actions/permissions` rejects a body carrying only `sha_pinning_required`; `enabled` is required alongside it, which is why `.github/settings/actions-permissions.json` carries all three fields.

Verify afterwards:

```sh
gh-axi api "repos/$REPO/rulesets" --jq '.[] | "\(.id) \(.name) \(.target) \(.enforcement)"'
gh-axi api "repos/$REPO/actions/permissions"
# Must read back the two values in .github/settings/actions-workflow-permissions.json.
gh-axi api "repos/$REPO/actions/permissions/workflow" \
  --jq '{default_workflow_permissions,can_approve_pull_request_reviews}'
```

`NPM_PUBLISH_ENABLED` is set only when the maintainer says so, and it is the last step, after a first manual publish and after the trusted publisher is configured:

```sh
gh-axi variable set NPM_PUBLISH_ENABLED --body true -R "$REPO"
```

## Known gaps

- **The Linux browser leg lifts an AppArmor restriction.**
  Ubuntu 24.04 confines unprivileged user namespaces, which is the mechanism Chrome's own sandbox uses, so `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` runs before the gate.
  That keeps Chrome's sandbox on, where the usual `--no-sandbox` workaround turns it off.
  If the runner image changes and the step becomes unnecessary, delete it rather than leaving it as folklore.
- **No watermark-scan backstop.**
  `automation`'s `shared-watermark-scan.yml` is out of reach for the same visibility reason as the secret scan, and it also requires the caller to carry `watermark-scan.py`, which this tree does not.
  The machine-wide pre-push hook is still the gate; nothing in CI re-checks a commit that bypassed it.
- **A person can still create a `v*` tag by hand.**
  The `creation` rule is unavailable here for the reason measured in "What protects main", so `scripts/release-preflight.js` is the only thing between a stray tag and a release attached to it.
  Moving the repository under an organization would make a GitHub App bypass actor legal and let `creation` come back; nothing else would.

- **Every release needs one human approval before its checks can run.**
  The cause and the two rejected remedies are in "Releasing"; the residual gap is that a release stalls silently, because a pull request whose checks never appeared reads the same as one whose checks have not finished.
  A token identity for release automation is the only thing that would close it.

- **No ruleset drift job.**
  The committed exports and the `diff` above are the whole mechanism, run by a person.
  A weekly job that reads the live rulesets would be better, and the token scope it needs is unverified.
