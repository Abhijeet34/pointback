# Project agent memory

Rules almost every agent session here needs, each with a pointer to the file that owns it.
`docs/ENGINEERING-NOTES.md` holds the measurements, run ids and incidents behind them; read its matching entry before changing anything a rule names.

## Working here

- `npm run check` is the whole gate (`README.md`, "Develop"); run it from an ordinary shell, because the browser suite binds a unix socket and `fs.watch` fails with `EMFILE` under a sandbox that denies `AF_UNIX` bind.
- A new `src/` module joins a layer in `scripts/check-deps.js`.
- The product name comes from `package.json` through `src/identity.js`; never write it as a literal under `src/`.
- `skills/pointback/SKILL.md` is the agent-facing CLI contract and ships outside the npm package; change it with any command, flag or field it names.
- Delivery is at-least-once, by an `ack` cursor and a session `epoch` (`#answer` in `src/session-store.js`, `poll-cursor.json`).
  A tab learns of sent notes only from the event stream, so Send and End never refetch the session (`changeDrafts` and `sending` in `src/browser/chrome.js`).
- One daemon per state directory: a start claims `daemon.<n>.lock` before it loads a session or binds (`claimDaemon` in `src/daemon-lock.js`), and `#persist` refuses a write only when the session file holds a readable session written more times than this process's copy.
- The daemon never closes an idle keep-alive connection on Node's timer (`keepAliveTimeout = 0` in `src/server.js`), so the browser always closes first; only the 30 min idle-out closes one (`docs/ENGINEERING-NOTES.md`, `test/server.test.js`).
- A review shows HTML or Markdown only (`artifactKind` in `src/markdown.js`); the daemon idles out and evicts at `limits.sessions`, never a review with a tab open (`touch` in `src/server.js`, `#evict` in `src/session-store.js`).
- `src/browser/` is static, excluded from coverage, and tested only by `test/browser.test.js` over the CDP harness in `test/helpers/cdp.js`.
  Never import Playwright into `test/*.test.js`; WebKit and Firefox are `npm run smoke` only.
  The smoke gates the release pull request, so it opens a review with `open` (the chrome's `ready`), never `page.goto` (`docs/ENGINEERING-NOTES.md`).
  Drive Annotate with the CDP harness, never chrome-devtools-axi, which never moves focus into the out-of-process frame.
- Tests touching the daemon take a private state directory and an ephemeral port from `test/helpers/env.js`, never `~/.pointback`.
  The browser suite shares one daemon, which never evicts a review holding notes and refuses an open past `limits.sessions`; its `afterEach` releases what each test leaves.
- A test that mocks `setTimeout` makes its HTTP requests with `node:http`, never `fetch`, which stalls on a reused connection under the mock on Node 24.20.0 (`docs/ENGINEERING-NOTES.md`).
- Every wait goes through `until` in `test/helpers/wait.js` and carries its own deadline; a failed wait on a tab or the page in it reports what the chrome showed, failed loads included (`describe` in `test/helpers/cdp.js`).
  A positive expectation waits for its condition; a negative one waits on the barrier proving the thing it rules out was handled (`handled` and `TRACK_API_ANSWERS` in `test/browser.test.js`), sleeping only where nothing would have fired and saying in a comment what the duration bounds; a latency is printed, never asserted.
- Never assert on the next line of an event stream: a failed watch arrives as `reload-off` on the same stream (`src/events.js`).
- A test needing a review in a known state takes its own (`copyOfFixture`); a browser test's agent poll runs after the notes are sent, with `--timeout-ms 0`.
- A test adds or sends on a tab it opened only once the chrome publishes its event stream open (`FOLLOWING` in `test/browser.test.js`): Windows refuses about 5 in 100000 of Chrome's new loopback connects, and a refused stream is retried after a pause (`docs/ENGINEERING-NOTES.md`).
- A test driving a tab it sent to the background calls `page.front()` first, and an animation assertion emulates `prefers-reduced-motion: no-preference` first.
- A key the chrome acts on is `preventDefault`ed, or headless Chromium on macOS freezes.
- The browser suite prints `browser suite: running against <path>` or `browser suite: SKIPPED`; a skip needs an explicit `<PREFIX>BROWSER=none`.
- `README.md` is a browser-suite fixture: its Install paragraph opens with `` `parse5` ``.
- The vendored house files under `src/browser/house/` are never edited; move the pin with `node scripts/sync-house.js`.
  The chrome uses `--hw-*` roles and rem sizes only (`src/browser/chrome.css`).
- Windows: `fileURLToPath`, never `new URL(...).pathname`; `realpathSync.native` wherever a path is watched or keyed; a read of a file another process is writing treats failure as "not yet"; in a test, no `shasum`, and spawning `npm` needs `shell: true`.

## Security boundaries

- A note is composed in the chrome, never the artifact; the chrome acts on what the frame proposes only under `gesture`, and pins carry no instruction or reply (`src/browser/chrome.js`).
  The page reaches the chrome only through the wrapper frame, served under the other loopback name (`pairedHost` in `src/http-guard.js`), whose own activation is the gesture; outside Chromium a key in the chrome also holds the page off for 5 s (`docs/THREAT-MODEL.md`).
  Read activation in a test through the wrapper's stamp, never a Playwright `evaluate` in a frame, which carries a gesture in Firefox and WebKit.
- A page that takes the focus from an open note is unloaded (`unload` in `src/browser/chrome.js`, owner `docs/THREAT-MODEL.md`), except a late refocus the hand-off takes back (`takenFrom` and `regained`); a test counts its keys and hears where the page put the focus through the console channel of `test/fixtures/focus-calls.html` (`pageTookFocus`), never a window flag or a call on the page's target, since the frame goes with the unload, which can land while the window is away.
- Replies are set as text, never HTML (`replyLine`).
- Only fonts under the root and the vendored house faces get `Access-Control-Allow-Origin` (`FONT_HEADERS` in `src/http-guard.js`); never widen it.
- The token in `server.json` goes only to a server that answered `tokenProof` (`src/http-guard.js`).
- The state directory is owner-only on both platforms (`src/state-dir.js`); assert it through `test/helpers/private.js`.
- `docs/THREAT-MODEL.md` owns the scope; no email address or personal contact detail belongs anywhere in this repository.

## Delivery

- `docs/GIT-WORKFLOW.md` is the whole of it; `scripts/apply-repo-settings.sh OWNER/REPO` alone applies the settings under `.github/rulesets/` and `.github/settings/`.
- The one required check is `checks` in `.github/workflows/ci.yml`; `test/pipeline.test.js` pins the load-bearing lines of the workflows and rulesets.
- Never hand-edit `.gitleaks.toml`, `.githooks/pre-push`, or the community files `repo-standard` renders (`CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, `NOTICE`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`); re-sync or change the standard upstream.
- No stored credential on the release path, never `provenance` in `publishConfig`, and prove a packaging change with `npm pack` (`test/identity.test.js`).

## CI runner platforms

A pull request runs Linux runners only; macOS and Windows run in `.github/workflows/cross-platform.yml`, and no tag or release is created until all three pass in the same run.
Never condition that matrix on whether a push looks like a release, never add `cancel-in-progress` to a release, publish or scheduled workflow, and never quote a glob in a `package.json` script.
A flake is proved absent by a count from `.github/workflows/windows-flake-hunt.yml`, never by a green tick.
