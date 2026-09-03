# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working here

- `npm run check` is the whole gate; `README.md` explains what each step is and why.
- Dependency direction for `src/` is the layer list in `scripts/check-deps.js`; add a new module to a layer there or the check fails.
- The product name is a parameter: `package.json` `name`, derived through `src/identity.js`; never write it as a literal under `src/`.
- Browser-side code (`src/browser/`) is served as static files, is excluded from coverage, and is tested only by the real-browser suite in `test/browser.test.js`.
- Two parts of the suite need an unsandboxed call on this fleet, so run `npm run check` from a terminal: the browser suite launches a headless browser, which needs to bind a process-singleton unix socket that a sandbox denying `AF_UNIX` bind refuses, and `fs.watch` fails there with `EMFILE: too many open files, watch` on the first event, which takes `watch`, `events` and `server` with it.
- A Chromium tab in the background starves queued tasks, including the `close` event of a `<dialog>`; a test that opens a second tab and then drives the first must bring it to the front (`page.front()` in `test/helpers/cdp.js`) or it will wait on an event that arrives seconds later.
- Tests that touch the daemon use `test/helpers/env.js` for a private state directory and an ephemeral port; never point a test at the real `~/.pointback`.
- The artifact iframe is sandboxed to an opaque origin, so Chromium runs it out of process and leaves it out of the page's frame tree; `Page.frame()` in `test/helpers/cdp.js` auto-attaches a session that can read its DOM, and input still goes to the page in page coordinates.
- No test may wait on an external process without its own deadline: `test/helpers/cdp.js` and `test/helpers/env.js` bound every browser and CLI wait and name what they waited for, and the browser is killed on every failure path.
  A leaked child keeps Node's event loop open after the suite has its verdict, so `npm test` also carries `--test-force-exit`; `--test-timeout` alone does not close a handle (measured on Node 24.11.1: a file leaking a child ran until killed from outside, force-exit ended the same run in 0.13 s).
- The browser suite says on stdout which of the two it did, `browser suite: running against <path>` or `browser suite: SKIPPED`, and CI lifts that line into the job summary.
  A skip needs an explicit `<PREFIX>BROWSER=none`; finding no browser at all fails.
- The page outline the SDK sends with every batch is capped in characters at both ends (`MAX_OUTLINE_CHARS` in `src/browser/sdk.js`, `structureChars` in `src/limits.js`) because it lands in an agent's context window on every delivery; `README.md` carries the measured before and after.

## Delivery

- `docs/GIT-WORKFLOW.md` is the whole of it: branch protection, required checks, versioning, release, rollback, and the settings to apply the day the repository exists.
- The settings that are not files live under `.github/rulesets/` and `.github/settings/`, and `scripts/apply-repo-settings.sh OWNER/REPO` is the only thing that applies them; never hand-type an API call it already carries.
- The one required status check is `checks` in `.github/workflows/ci.yml`; anything worth blocking a merge becomes a job there, never a second required context.
- `.gitleaks.toml` and `.githooks/pre-push` are `automation`'s canonical copies, installed by its `.ci/gitleaks/sync.sh` and digest-pinned in CI. Never hand-edit either; re-run `sync.sh`.
- `test/pipeline.test.js` pins the load-bearing lines of the workflows and rulesets, so a change that quietly unprotects something fails the gate.

## CI runner platforms

A pull request runs Linux runners only.
GitHub bills a macOS minute at about 10x a Linux one and a Windows minute at about 1.67x, all against the same allowance, so a three-platform matrix on `pull_request` spends most of the budget proving what the cheapest runner already proved.
macOS and Windows coverage lives in `.github/workflows/cross-platform.yml`, on a weekly `schedule:`, on `workflow_dispatch`, and on the release path through `workflow_call`.
Do not add a `macos-*` or `windows-*` runner to a job that runs on `pull_request`.
The step that runs the suite carries its own `timeout-minutes`, always smaller than its job's, and `test/pipeline.test.js` pins that: a step over budget fails and reports a verdict, while a job over `timeout-minutes` is reported `cancelled`, which the `checks` aggregate can only refuse.
Never add `cancel-in-progress` to a release, publish, or scheduled workflow: cancelling a publish mid-flight causes real damage, and a superseded scheduled run is the only record of its own result.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
