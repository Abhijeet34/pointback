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
- [The identity release automation runs as](#the-identity-release-automation-runs-as)
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

| Event                         | Jobs                                                                                                 | Billed Linux minutes                       | If private                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Push to a pull request        | `check`, `secret scan`, `dependency review`, `checks`                                                | 2 + 2 + 1 + 1 = 6                          | $0.036                            |
| Merge to `main`               | `check`, `secret scan`, `checks`, `release-pr`, `release-pr-checks`, `cross-platform`, `release-tag` | 2 + 2 + 1 + 1 + 1 + 1 = 8, plus the matrix | $0.048 + $0.228 = $0.276          |
| Weekly `cross-platform`       | macOS 3, Windows 3, Linux 2                                                                          | n/a                                        | $0.186 + $0.030 + $0.012 = $0.228 |
| Release (on top of the merge) | `artifacts`, `publish`                                                                               | n/a                                        | $0.006 + $0.006 = $0.012          |

The per-job minutes are an upper bound, not a measurement: the whole gate runs in 6.7 s locally with dependencies installed, so every job here is dominated by checkout and `npm ci` rather than by its own work, and the arithmetic is dominated by GitHub's per-job rounding.
Replace them with `started_at` to `completed_at` from the first ten runs.

The merge row is where the tag gate is paid for.
macOS and Windows are back on every merge, because the only way to gate the tag without a second opinion about whether a push is a release is to run the matrix on all of them; `release.yml` carries that reasoning above the job.
Against the reference implementation's measured figures in section 5.1 of that design, $0.018 per pull request push and $0.100 per merge on a three-OS matrix: the pull request here costs twice as much because it runs three gates the reference splits across four separate workflows, and the merge costs about 2.8x as much because it now runs the matrix the reference splits across its own release workflow.
The macOS leg is the whole difference, there and here.
It sat at exactly 60 seconds there and was 62 percent of that repository's merge cost on its own.
None of it is billed while this repository is public.

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
any squash-merge to main
  ├─ release-pr ───────── opens or updates "chore(main): release x.y.z", tags nothing
  ├─ release-pr-checks ── releases that pull request's parked run, so it is checked
  └─ cross-platform ───── Linux, macOS and Windows on this exact tree
       └─ release-tag ─── nothing above it has tagged; this is the only job that can
            ├─ artifacts ── preflight, npm pack, SBOM, build provenance, upload both
            └─ publish ──── only if the NPM_PUBLISH_ENABLED repository variable is "true"

on an ordinary merge, release-tag finds no merged release pull request and reports
created=false, so artifacts and publish skip. On the merge of the release pull
request it writes CHANGELOG.md and package.json, tags vX.Y.Z and creates the release.
```

Merging is the one step a person takes, and it is the one step that should stay theirs.
Everything on either side of it is machinery.

`CHANGELOG.md` is release-please's file.
Nobody edits it by hand.
`.prettierignore` excludes it for that reason: it is generated markdown, not formatted source, and `format:check` reading it failed the release pull request before anyone could review the release.

**The release pull request's CI does not start on its own, and `release-pr-checks` is what starts it.**
GitHub's documentation on triggering a workflow states the cause: when a workflow using `GITHUB_TOKEN` creates or updates a pull request, the resulting `pull_request` event creates workflow runs in an approval-required state.
release-please opens the release pull request with exactly that token.
Its run therefore completes as `action_required` having produced no check runs at all, the required `checks` context never appears, and the one pull request that carries a release was the one pull request in this repository that nothing checked.

Measured here, not inferred.
Six of the eight `pull_request` runs ever created on `release-please--branches--main--components--pointback` concluded `action_required`: `33800809078`, `33801077938`, `33827701874`, `33847530622`, `33848542837`, `33849288493`.
The two that did not, `33816315115` and `33818965689`, ran because a person clicked.
On 2026-09-04, `GET /repos/OWNER/REPO/commits/b06ba06.../check-runs` answered `total_count: 0` and `.../status` answered `total_count: 0, state: pending`, while pull request 12 on this repository at the same moment reported four check runs.
Note what that rules out: the runs are created and then held, so this is not the blanket rule that a `GITHUB_TOKEN` event creates no run at all.

`scripts/approve-release-checks.js` releases them, and the `release-pr-checks` job runs it after `release-please` on every push to `main`.
It holds `actions: write` and no other write, and the only pull request it can reach is one whose author is `github-actions[bot]`, whose head branch starts `release-please--` and is in this repository rather than a fork, and whose base is the default branch.
`test/approve-release-checks.test.js` puts one impostor against each of those four clauses.
A parked run it cannot release fails the job, because the thing being replaced is a release that stalls in silence: a pull request whose checks never appeared reads exactly like one whose checks have not finished.

**That the workflow's own `GITHUB_TOKEN` may approve was measured, because the REST documentation does not say.**
The page for `POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve` names a scope for OAuth and classic tokens and lists no fine-grained permission at all.
Run `33852140477` ran this script under `GITHUB_TOKEN` with `permissions: actions: write`, printed `approving run 33851478839 on #10` and then `#10 at 74fc89a... now faces the same gates as any other pull request`, in a step that took 2.3 seconds.
Pull request 10 went from "no CI checks configured" to `check`, `secret scan` and `dependency review` running on it.
No credential was stored to do that, and none is stored anywhere on this path.

**Two gates run the three platforms, and they protect different things.**

The first is on the release pull request, and it keeps `main` releasable.
The `cross-platform` job in `ci.yml` calls the reusable workflow, guarded on `startsWith(github.head_ref, 'release-please--')` and on the head repository matching this one, and reaches branch protection through `checks` like every other job.
Every other pull request skips it and pays nothing.
That the guard fires was measured on a throwaway pull request from a `release-please--` branch: run `33853207426` reported seven jobs green - `check`, `secret scan`, `dependency review`, all three `cross-platform` legs, and `checks` - where the same tree on an ordinary branch reports four and skips the matrix.

The second is on the tag, and it is the one that took two empty releases to get right.
Gating the pull request's merge does not gate the tag, because the tag is not cut by that run.
It is cut by the next run, on `main`, and there `release-please` was the first job in the file: it tagged and published before any platform had said a word, and the `artifacts` job that attaches the tarball hung off a matrix that had already failed.
Twice, identically.
On run `33822348514` the tag `v0.1.0` and release `382407638` were created and `windows-2025` then failed; on run `33859541647`, with the pull-request gate in place and the release pull request green on all seven checks, `v0.1.1` and release `382616199` were created and `windows-2025` failed again.
Both releases stand with `assets: []`: no tarball, no SBOM, no attestation.

So `release-please` is split by its own two skip inputs.
`release-pr` runs it with `skip-github-release: true`, which the action documents as "if set to true, then do not try to tag releases", and that half stays in front of the matrix: gating it would stop the release pull request from ever being opened, which is a worse failure than the one being fixed.
`release-tag` runs it with `skip-github-pull-request: true`, needs `cross-platform`, and is the only job in the repository that can create a tag.

The matrix that gates it is conditioned on nothing.
Asking "is this push a release?" first is what would put the defect back: that answer is release-please's to give, and a second opinion answering "no" when the truth is "yes" would skip the matrix, skip `release-tag` with it, and drop the release in silence.
So every push to `main` pays for macOS and Windows, and `main` gets three-platform coverage on every commit rather than once a week.

Measured in GitHub's own engine, on a stub derived from `release.yml` with the same jobs, the same `needs:` and the same `if:`, every step replaced by an `echo` and the matrix by one whose `windows-2025` leg fails on demand.
With that leg red, run `33863831974`: `release-pr` success, `release-pr-checks` success, `release-tag` **skipped**, `artifacts` skipped, `publish` skipped.
With all three green, run `33864417184`: `release-tag` success, `artifacts` success, `publish` skipped on the repository variable.
The real path is proven only by the next real release, and what that would show is `release-tag` starting after three green legs and `artifacts` attaching a tarball and an SBOM to the tag it made.

A gate that runs after the thing it was meant to prevent is decoration.

The `artifacts` job checks the tag out rather than `main`, so the tarball is packed from the tagged tree, and the `cross-platform` job upstream of it ran on the release commit, which the preflight proves is the commit the tag names.
The SBOM comes from GitHub's dependency-graph export (`gh api repos/OWNER/REPO/dependency-graph/sbom`), which describes the manifests from the same data the pull request dependency review reads.
`actions/attest-build-provenance` signs the tarball, so the release asset is verifiable with `gh attestation verify` whether or not it was ever published to npm.

## The identity release automation runs as

Release automation runs as `github-actions[bot]`, holding the per-run `GITHUB_TOKEN` and nothing else.
Two alternatives exist. Neither is taken, and the table is why.

| Identity                                                             | To set up                                                                           | Forever after                                                    | What a leak hands over                                                                                    | When a person leaves                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GITHUB_TOKEN` as `github-actions[bot]`, current                     | Nothing; it is the default                                                          | Nothing to store, rotate or renew                                | Nothing outlives the job it was minted for, and its scope is this repository                              | Nothing changes; the identity belongs to the repository                   |
| A GitHub App, minting an installation token per run                  | Create the app, generate a private key, install it, store the id and key as secrets | A private key on a rotation calendar, and an app to maintain     | Installation tokens for every repository the app is installed on, from anywhere, until the key is revoked | An app on a personal account leaves with the account unless transferred   |
| A fine-grained PAT with `contents: write` and `pull-requests: write` | Mint it, store it as a repository secret                                            | Re-mint it before it expires; GitHub caps the lifetime at a year | Write on this repository's contents and pull requests, as the person who minted it, until it is revoked   | It dies with the account and the release path stops the next time it runs |

Both alternatives exist for one reason.
An installation token and a PAT are not `GITHUB_TOKEN`, so a pull request opened with one is not held for approval, and the click disappears.
`release-pr-checks` removes the click without either, so a credential with a lifetime would buy nothing that a job holding `actions: write` for one API call does not already do.

Weigh them against the word that matters, which is untethered.
The current identity depends on no stored secret, no person being available, and no personal account.
The other two fail on the first, and on a user-owned repository the app also fails on the third.

The cheapest identity is the one nobody has to remember.

## Publishing to npm

Off.
The `publish` job runs only when the repository variable `NPM_PUBLISH_ENABLED` is exactly `true`, and that variable is now the whole switch.
With the variable unset the release ends at the tag, the GitHub release and its two assets, and the job is visibly skipped rather than quietly absent.
`package.json` used to hold a second refusal in `"private": true` and `"license": "UNLICENSED"`; both were dropped once the name was settled and the licence became Apache-2.0, so the variable stands alone.
`scripts/release-preflight.js --publishing` still refuses a publish with `private` true, with the licence absent or `UNLICENSED`, or with no `files` allowlist, which is what catches a regression to any of those rather than a first setup.

**Trusted publishing is configured on this side and on no other, and the rest cannot be done from this repository.**
The workflow half is real: `id-token: write` on the `publish` job, `registry-url` on `setup-node`, the npm version assertion, and `npm publish` with no `--provenance` flag.
The registry half does not exist.
`GET https://registry.npmjs.org/pointback` answered `404 {"error":"Not found"}` on 2026-09-04, so there is no package, no package settings page, and therefore no trusted publisher to match the OIDC claim against.
Setting `NPM_PUBLISH_ENABLED` today would reach `npm publish` and fail with `ENEEDAUTH`, after the tag and the GitHub release already exist.

Two things have to happen on npmjs.com first, and neither can be done from here:

1. Publish `0.1.0` by hand, once, from a laptop with `npm login` and 2FA. `npm/cli#8544`, "Allow publishing initial version with OIDC", is open on exactly this.
1. Configure the trusted publisher on the package's settings page: this repository, and the workflow filename `release.yml`, both case-sensitive and exact.

`package.json` also carries a `repository` field now, which it did not.
npm's provenance prerequisites require "a public `repository` that matches (case-sensitive) where you are publishing with provenance from", trusted publishing generates provenance by default, and without the field the publish fails at the registry with the tag already cut.
`scripts/release-preflight.js --publishing` refuses that case now, alongside `private`, the licence and the `files` allowlist, so it is caught on the runner rather than by npm.

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

Check the npmjs.com form at the time: if it offers a trusted publisher for a name that has never been published, skip the manual first publish above.

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

- **The tag is created before `artifacts` runs, and nothing can take it back.**
  Both the merge and the tag are gated on all three platforms now, so the tree is proven twice; what is not gated is the four steps after the tag, and a failure in any of them leaves a real release carrying no assets.
  That is what releases `382407638` and `382616199` are: v0.1.0 and v0.1.1, both `assets: []`, from runs `33822348514` and `33859541647`.
  A draft release promoted by `artifacts` would close it, and was not taken here because GitHub withholds the tag itself until a draft release is published, which `scripts/release-preflight.js` resolves and compares.

- **Approving the release pull request's checks is not reviewing them.**
  `release-pr-checks` starts the gates; it does not merge, and `required_approving_review_count` is 0, so a green release pull request can be merged by anyone with write access.
  That is the same property every pull request here has, recorded in "What protects main", and the approval job does not change it.

- **No ruleset drift job.**
  The committed exports and the `diff` above are the whole mechanism, run by a person.
  A weekly job that reads the live rulesets would be better, and the token scope it needs is unverified.
