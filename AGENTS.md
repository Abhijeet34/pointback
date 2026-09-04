# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working here

- `npm run check` is the whole gate; `README.md` explains what each step is and why.
- Dependency direction for `src/` is the layer list in `scripts/check-deps.js`; add a new module to a layer there or the check fails.
- The product name is a parameter: `package.json` `name`, derived through `src/identity.js`; never write it as a literal under `src/`.
- A review has a bounded lifecycle. The daemon idles out on inactivity (`touch` in `src/server.js`), and a tab keeps it alive only by heartbeating while visible (`startHeartbeat` in `src/browser/chrome.js`, paced by the `idleMs` that `/health` reports), so an abandoned tab releases the process instead of pinning it open. `SessionStore.#evict` disposes the least-recently-active session (an ended review first, never one with a poll attached) when `open` hits `limits.sessions`, so `state.json` stays bounded. `test/server.test.js` and `test/browser.test.js` prove both.
- Delivery is at-least-once. `#answer` in `src/session-store.js` moves a batch from `pending` to `unacked` and holds it there until a later poll's `ack` cursor (its high `uid`) confirms receipt; a fresh poll redelivers an unacknowledged batch, an event-woken poll does not, so a lost response redelivers by `uid` and two pollers never split one batch. `pointback poll` threads that cursor through `poll-cursor.json` in the state dir (`readPollCursor`/`writePollCursor`), writing it only after the batch is on stdout. The note card is composed in the chrome, never in the artifact (`src/browser/chrome.js`); the artifact proposes a target and the chrome reads the instruction, so a hostile page cannot forge a note. `test/browser.test.js` proves the forge fails and `test/server.test.js`/`test/session-store.test.js` prove redelivery.
- Browser-side code (`src/browser/`) is served as static files, is excluded from coverage, and is tested only by the real-browser suite in `test/browser.test.js`.
- The browser suite is the one part that a restrictive sandbox still breaks, so run `npm run check` from an ordinary shell: it launches a headless browser that binds a process-singleton unix socket, which a sandbox denying `AF_UNIX` bind refuses.
  `fs.watch` fails under such a sandbox too, with `EMFILE: too many open files, watch` on the first event, but `watch`, `events` and `server` survive it: `test/helpers/watch.js` decides watch support by watching a real file with the product's own watcher, and each test that depends on it states which path it is exercising and asserts that one.
  Never assert on the next line of an event stream in those suites. `src/events.js` turns a failed watch into a `reload-off` on the same stream that carries `superseded`, so a test taking whichever line arrives next reports the identical result whether the behaviour it exists for works or is broken - which is how one sandboxed `superseded` assertion spent a day being read as a known environment artifact.
- A Chromium tab in the background starves queued tasks, including the `close` event of a `<dialog>`; a test that opens a second tab and then drives the first must bring it to the front (`page.front()` in `test/helpers/cdp.js`) or it will wait on an event that arrives seconds later.
- Tests that touch the daemon use `test/helpers/env.js` for a private state directory and an ephemeral port; never point a test at the real `~/.pointback`.
- The artifact iframe is sandboxed to an opaque origin, so Chromium runs it out of process and leaves it out of the page's frame tree; `Page.frame()` in `test/helpers/cdp.js` auto-attaches a session that can read its DOM, and input still goes to the page in page coordinates.
- No test may wait on an external process without its own deadline: `test/helpers/cdp.js` and `test/helpers/env.js` bound every browser and CLI wait and name what they waited for, and the browser is killed on every failure path.
  A leaked child keeps Node's event loop open after the suite has its verdict, so `npm test` also carries `--test-force-exit`; `--test-timeout` alone does not close a handle (measured on Node 24.11.1: a file leaking a child ran until killed from outside, force-exit ended the same run in 0.13 s).
- The browser suite says on stdout which of the two it did, `browser suite: running against <path>` or `browser suite: SKIPPED`, and CI lifts that line into the job summary.
  A skip needs an explicit `<PREFIX>BROWSER=none`; finding no browser at all fails.
- The mark is one geometry in two places, `src/browser/icon.svg` for the tab and the same paths inlined in `chrome.html` for the header; `README.md`, "Develop", says how `icon-32.png` is regenerated when the SVG changes. Neither file may contain the product name (`test/identity.test.js`).
- Windows is a supported platform and five things in this tree exist only because it is.
  Never use `new URL(...).pathname` as a filesystem path: it yields `/D:/a/...` there, which is why the daemon never started and why `npm run deps` and the release preflight both exited 0 having checked nothing; `fileURLToPath` is the only correct form.
  Resolve with `realpathSync.native`, never the JavaScript `realpathSync`, anywhere a path is watched or keyed: only the native call expands an 8.3 short name such as `C:\Users\RUNNER~1\...`, and `fs.watch` on an unexpanded one trips a libuv assertion that aborts the whole daemon.
  Never read a file another process is writing without treating the read's own failure as "not yet": Windows locks `DevToolsActivePort` while Chromium holds it, `readFileSync` answers EBUSY rather than a partial line, and that threw out of the launcher's poll and failed the whole browser suite in 5 of 20 consecutive `windows-2025` runs (run 33864656156).
  Never remove a directory a process has just been told to exit without `maxRetries`: the exit is not every handle being released, Windows answers EPERM until it is, and that threw out of `after()` and failed the whole browser file in 2 of 20 consecutive runs (run 33867055764) with every test in it green.
  In a test, `shasum` does not exist and `npm` is a `.cmd` Node refuses to spawn without `shell: true`.
- A wait that polls a flag living in another document has to arm that flag as it polls, not once in front of the loop: the document can be replaced under it, and a wait that never looks again reads a value nothing can set until its budget runs out.
  `pointerInto` in `test/helpers/cdp.js` is the one that had it, and its failure message now separates the three things that reach it - geometry measured too early, an unarmed frame, and input that was never routed - because the coordinate alone identified none of them.
- The state directory's owner-only protection is a security property with two platform spellings, both in `src/state-dir.js`: POSIX mode bits, and on Windows an ACL reset to one full-control entry for the current user that every file inside inherits.
  `/inheritance:r` alone is not enough, because a directory an administrator creates carries SYSTEM and `BUILTIN\Administrators` as its own explicit entries.
  Assert the property through `test/helpers/private.js`, never `statSync(...).mode` directly, and keep the re-tightening test's `loosen()` call so it cannot pass vacuously.
- The page outline the SDK sends with every batch is capped in characters at both ends (`MAX_OUTLINE_CHARS` in `src/browser/sdk.js`, `structureChars` in `src/limits.js`) because it lands in an agent's context window on every delivery; `README.md` carries the measured before and after.

## Delivery

- `docs/GIT-WORKFLOW.md` is the whole of it: branch protection, required checks, versioning, release, rollback, and how the settings that are not files are applied and verified.
- The settings that are not files live under `.github/rulesets/` and `.github/settings/`, and `scripts/apply-repo-settings.sh OWNER/REPO` is the only thing that applies them; never hand-type an API call it already carries.
- The one required status check is `checks` in `.github/workflows/ci.yml`; anything worth blocking a merge becomes a job there, never a second required context.
- `.gitleaks.toml` and `.githooks/pre-push` are copies of one canonical secret-scanning gate maintained outside this repository, in a private upstream shared across its siblings. Never hand-edit either: `ci.yml` pins the SHA-256 of both, so a drifted copy fails the required check, and the fix is to re-sync from upstream rather than to edit the file here.
- `test/pipeline.test.js` pins the load-bearing lines of the workflows and rulesets, so a change that quietly unprotects something fails the gate.
- A release pull request is opened with `GITHUB_TOKEN`, so GitHub creates its `pull_request` run in an approval-required state and it completes as `action_required` with zero check runs. The `release-pr-checks` job in `release.yml` releases it, through `scripts/approve-release-checks.js`, which may only ever reach a pull request authored by `github-actions[bot]` from a `release-please--` branch in this repository against the default branch; never widen those four clauses. `docs/GIT-WORKFLOW.md`, "Releasing", carries the measurement and the run ids on both sides of it. Anything asserted about the pre-release state, such as the `0.0.0` manifest sentinel, must stop asserting once `CHANGELOG.md` exists, or the release pull request's own diff fails the gate.
- Release automation runs as `github-actions[bot]` holding the per-run `GITHUB_TOKEN`, and no stored credential exists anywhere on the release path. Do not introduce one: `docs/GIT-WORKFLOW.md`, "The identity release automation runs as", prices the two alternatives that were refused.
- The repository is public and licensed Apache-2.0 (`LICENSE`, copyright Abhijeet Halder); `SECURITY.md` routes vulnerability reports through GitHub private advisories, and no email address or other personal contact detail belongs anywhere in this repository. Publishing to npm stays off behind the `NPM_PUBLISH_ENABLED` repository variable, pinned by `test/pipeline.test.js`.

## CI runner platforms

A pull request runs Linux runners only.
GitHub bills a macOS minute at about 10x a Linux one and a Windows minute at about 1.67x, all against the same allowance, so a three-platform matrix on `pull_request` spends most of the budget proving what the cheapest runner already proved.
macOS and Windows coverage lives in `.github/workflows/cross-platform.yml`, on a weekly `schedule:`, on `workflow_dispatch`, and through `workflow_call` from both `ci.yml` and `release.yml`.
Do not add a `macos-*` or `windows-*` runner to a job that runs on `pull_request`, with the one exception the `cross-platform` job in `ci.yml` already is: that pull request alone calls the matrix, guarded on `startsWith(github.head_ref, 'release-please--')` and same-repository head, and every other one skips it.
Every push to `main` runs the matrix too, and that is not optional: it is what gates the tag.
Nothing in this repository may create a tag or a GitHub release until all three platforms have passed in the same run, and `release-please` is therefore split across two jobs by its own skip inputs - `release-pr` (`skip-github-release: true`) in front of the matrix so the release pull request is still opened, `release-tag` (`skip-github-pull-request: true`) behind it as the only job that can tag.
Never condition that matrix on whether the push looks like a release: release-please owns that answer, and a second opinion answering "no" wrongly skips the matrix, skips `release-tag` with it, and drops the release in silence.
Two empty releases came from getting this wrong - v0.1.0 on run 33822348514 and v0.1.1 on run 33859541647, both `assets: []` - and `test/pipeline.test.js` now pins the ordering; `docs/GIT-WORKFLOW.md`, "Releasing", carries the measurement.
The step that runs the suite carries its own `timeout-minutes`, always smaller than its job's, and `test/pipeline.test.js` pins that: a step over budget fails and reports a verdict, while a job over `timeout-minutes` is reported `cancelled`, which the `checks` aggregate can only refuse.
Never add `cancel-in-progress` to a release, publish, or scheduled workflow: cancelling a publish mid-flight causes real damage, and a superseded scheduled run is the only record of its own result.
`.gitattributes` pins the working tree to LF everywhere, because the Windows runner checks out under `core.autocrlf=true` and `prettier --check` then refuses every text file in the tree; that, not a missing browser, is what failed `windows-2025` on the 0.1.0 release, and `test/pipeline.test.js` pins the file.
Chrome is present on all three runner images, and both workflows resolve it through `KNOWN_BROWSERS` in `test/helpers/cdp.js` rather than naming a path, so a moved binary is one edit there.
Never quote a glob in a `package.json` script: npm runs a script through `cmd.exe` on Windows and cmd keeps the quotes, so `'test/*.test.js'` reached `node --test` with its quote characters, matched nothing, and passed `windows-2025` green over zero tests on run 33824393013.
Each leg reports in its own job summary which browser it drove, and a leg that reports no verdict fails; that is the guard against the same silence going green again.
All three platforms pass the whole suite; keep it that way by reading the two Windows entries under "Working here" before touching a path, a spawn or a file mode.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
