# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working here

- `npm run check` is the whole gate; `README.md` explains what each step is and why.
- Dependency direction for `src/` is the layer list in `scripts/check-deps.js`; add a new module to a layer there or the check fails.
- The product name is a parameter: `package.json` `name`, derived through `src/identity.js`; never write it as a literal under `src/`.
- Delivery is at-least-once. `#answer` in `src/session-store.js` moves a batch from `pending` to `unacked` and holds it there until a later poll's `ack` cursor (its high `uid`) confirms receipt; a fresh poll redelivers an unacknowledged batch, an event-woken poll does not, so a lost response redelivers by `uid` and two pollers never split one batch. `pointback poll` threads that cursor through `poll-cursor.json` in the state dir (`readPollCursor`/`writePollCursor`), writing it only after the batch is on stdout. The note card is composed in the chrome, never in the artifact (`src/browser/chrome.js`); the artifact proposes a target and the chrome reads the instruction, so a hostile page cannot forge a note. `test/browser.test.js` proves the forge fails and `test/server.test.js`/`test/session-store.test.js` prove redelivery.
- Browser-side code (`src/browser/`) is served as static files, is excluded from coverage, and is tested only by the real-browser suite in `test/browser.test.js`.
- Two parts of the suite break under a restrictive sandbox, so run `npm run check` from an ordinary shell: the browser suite launches a headless browser that binds a process-singleton unix socket, which a sandbox denying `AF_UNIX` bind refuses, and `fs.watch` fails there with `EMFILE: too many open files, watch` on the first event, which takes `watch`, `events` and `server` with it.
- A Chromium tab in the background starves queued tasks, including the `close` event of a `<dialog>`; a test that opens a second tab and then drives the first must bring it to the front (`page.front()` in `test/helpers/cdp.js`) or it will wait on an event that arrives seconds later.
- Tests that touch the daemon use `test/helpers/env.js` for a private state directory and an ephemeral port; never point a test at the real `~/.pointback`.
- The artifact iframe is sandboxed to an opaque origin, so Chromium runs it out of process and leaves it out of the page's frame tree; `Page.frame()` in `test/helpers/cdp.js` auto-attaches a session that can read its DOM, and input still goes to the page in page coordinates.
- No test may wait on an external process without its own deadline: `test/helpers/cdp.js` and `test/helpers/env.js` bound every browser and CLI wait and name what they waited for, and the browser is killed on every failure path.
  A leaked child keeps Node's event loop open after the suite has its verdict, so `npm test` also carries `--test-force-exit`; `--test-timeout` alone does not close a handle (measured on Node 24.11.1: a file leaking a child ran until killed from outside, force-exit ended the same run in 0.13 s).
- The browser suite says on stdout which of the two it did, `browser suite: running against <path>` or `browser suite: SKIPPED`, and CI lifts that line into the job summary.
  A skip needs an explicit `<PREFIX>BROWSER=none`; finding no browser at all fails.
- The page outline the SDK sends with every batch is capped in characters at both ends (`MAX_OUTLINE_CHARS` in `src/browser/sdk.js`, `structureChars` in `src/limits.js`) because it lands in an agent's context window on every delivery; `README.md` carries the measured before and after.

## Delivery

- `docs/GIT-WORKFLOW.md` is the whole of it: branch protection, required checks, versioning, release, rollback, and how the settings that are not files are applied and verified.
- The settings that are not files live under `.github/rulesets/` and `.github/settings/`, and `scripts/apply-repo-settings.sh OWNER/REPO` is the only thing that applies them; never hand-type an API call it already carries.
- The one required status check is `checks` in `.github/workflows/ci.yml`; anything worth blocking a merge becomes a job there, never a second required context.
- `.gitleaks.toml` and `.githooks/pre-push` are copies of one canonical secret-scanning gate maintained outside this repository, in a private upstream shared across its siblings. Never hand-edit either: `ci.yml` pins the SHA-256 of both, so a drifted copy fails the required check, and the fix is to re-sync from upstream rather than to edit the file here.
- `test/pipeline.test.js` pins the load-bearing lines of the workflows and rulesets, so a change that quietly unprotects something fails the gate.
- A release pull request is opened by `github-actions[bot]`, and GitHub parks its CI at `action_required` with zero check runs until a maintainer approves it; `docs/GIT-WORKFLOW.md`, "Releasing", carries the measurement, the one-line approval command and why no setting lifts it. Anything asserted about the pre-release state, such as the `0.0.0` manifest sentinel, must stop asserting once `CHANGELOG.md` exists, or the release pull request's own diff fails the gate.
- The repository is public and licensed Apache-2.0 (`LICENSE`, copyright Abhijeet Halder); `SECURITY.md` routes vulnerability reports through GitHub private advisories, and no email address or other personal contact detail belongs anywhere in this repository. Publishing to npm stays off behind the `NPM_PUBLISH_ENABLED` repository variable, pinned by `test/pipeline.test.js`.

## CI runner platforms

A pull request runs Linux runners only.
GitHub bills a macOS minute at about 10x a Linux one and a Windows minute at about 1.67x, all against the same allowance, so a three-platform matrix on `pull_request` spends most of the budget proving what the cheapest runner already proved.
macOS and Windows coverage lives in `.github/workflows/cross-platform.yml`, on a weekly `schedule:`, on `workflow_dispatch`, and on the release path through `workflow_call`.
Do not add a `macos-*` or `windows-*` runner to a job that runs on `pull_request`.
The step that runs the suite carries its own `timeout-minutes`, always smaller than its job's, and `test/pipeline.test.js` pins that: a step over budget fails and reports a verdict, while a job over `timeout-minutes` is reported `cancelled`, which the `checks` aggregate can only refuse.
Never add `cancel-in-progress` to a release, publish, or scheduled workflow: cancelling a publish mid-flight causes real damage, and a superseded scheduled run is the only record of its own result.
`.gitattributes` pins the working tree to LF everywhere, because the Windows runner checks out under `core.autocrlf=true` and `prettier --check` then refuses every text file in the tree; that, not a missing browser, is what failed `windows-2025` on the 0.1.0 release, and `test/pipeline.test.js` pins the file.
Chrome is present on all three runner images, and both workflows resolve it through `KNOWN_BROWSERS` in `test/helpers/cdp.js` rather than naming a path, so a moved binary is one edit there.
Never quote a glob in a `package.json` script: npm runs a script through `cmd.exe` on Windows and cmd keeps the quotes, so `'test/*.test.js'` reached `node --test` with its quote characters, matched nothing, and passed `windows-2025` green over zero tests on run 33824393013.
Each leg reports in its own job summary which browser it drove, and a leg that reports no verdict fails; that is the guard against the same silence going green again.
The product itself does not pass on Windows: `docs/GIT-WORKFLOW.md`, "Known gaps", carries the 20 failures grouped by cause, and the leg stays red until that product decision is made.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
