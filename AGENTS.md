# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working here

- `npm run check` is the whole gate; `README.md` explains what each step is and why.
- Dependency direction for `src/` is the layer list in `scripts/check-deps.js`; add a new module to a layer there or the check fails.
- The product name is a parameter: `package.json` `name`, derived through `src/identity.js`; never write it as a literal under `src/`.
- Browser-side code (`src/browser/`) is served as static files, is excluded from coverage, and is tested only by the real-browser suite in `test/browser.test.js`.
- The browser suite launches a headless browser, which needs to bind a process-singleton unix socket; a sandbox that denies `AF_UNIX` bind (the Claude Code Bash sandbox on this fleet) fails it, so run `npm run check` from a terminal or an unsandboxed call.
- Tests that touch the daemon use `test/helpers/env.js` for a private state directory and an ephemeral port; never point a test at the real `~/.pointback`.

## Delivery

- `docs/GIT-WORKFLOW.md` is the whole of it: branch protection, required checks, versioning, release, rollback, and the settings to apply the day the repository exists.
- The one required status check is `checks` in `.github/workflows/ci.yml`; anything worth blocking a merge becomes a job there, never a second required context.
- `.gitleaks.toml` and `.githooks/pre-push` are `automation`'s canonical copies, installed by its `.ci/gitleaks/sync.sh` and digest-pinned in CI. Never hand-edit either; re-run `sync.sh`.
- `test/pipeline.test.js` pins the load-bearing lines of the workflows and rulesets, so a change that quietly unprotects something fails the gate.

## CI runner platforms

A pull request runs Linux runners only.
GitHub bills a macOS minute at about 10x a Linux one and a Windows minute at about 1.67x, all against the same allowance, so a three-platform matrix on `pull_request` spends most of the budget proving what the cheapest runner already proved.
macOS and Windows coverage lives in `.github/workflows/cross-platform.yml`, on a weekly `schedule:`, on `workflow_dispatch`, and on the release path through `workflow_call`.
Do not add a `macos-*` or `windows-*` runner to a job that runs on `pull_request`.
Never add `cancel-in-progress` to a release, publish, or scheduled workflow: cancelling a publish mid-flight causes real damage, and a superseded scheduled run is the only record of its own result.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
