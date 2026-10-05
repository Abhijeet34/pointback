# Threat model

`SECURITY.md` gives the reporting route and the response times.
This document says which reports are in scope for pointback, and what a pointback report should name.

## Scope

pointback runs on one person's machine and serves one reviewer.
The server binds `127.0.0.1` only, every API call carries a capability token from `~/.pointback/server.json`, and the process opens no outbound connection at all (`test/egress.test.js` asserts that across the whole slice).
Reports are in scope when they break one of those boundaries.

In scope:

- Reaching the API without the token in `~/.pointback/server.json`: the loopback host check, the origin check, or the constant-time bearer comparison in `src/http-guard.js`, including DNS rebinding onto the bound port.
- Recovering the token by listening on the port a daemon left when it exited.
  The token outlives the process, so the CLI and the review tab present it only to a server that has proved it holds it (`tokenProof` in `src/http-guard.js`), and a daemon that cannot take its old port back mints a fresh one.
  The one exception stops a daemon from 0.1.4 or earlier, which predates the proof: to a server on the recorded port that answers `{"app":"pointback"}` without a proof, the CLI sends the token once on `POST /shutdown` and then retires it in `server.json` whether or not that server stopped (`stopServer` in `src/client.js`).
  A retired token is never shown again: while its recorded process is alive and its port still answers as this app, every open refuses (`ensureServer` in `src/client.js`), and `pointback stop` signals no pid there, because the CLI cannot prove that pid still belongs to this app.
  Once that port stops answering, the next daemon mints a fresh token.
  A squatter that answers that way receives a token no running daemon accepts; a token that still opens a daemon after that exchange is in scope.
- Escaping the artifact iframe: the page under review reading the review chrome or its wrapper frame, calling the API, or recovering the server token from the URL fragment the chrome page is opened with (`src/browser/`).
- Reading or writing a file outside the review's root through the asset route, by traversal, encoding, separator, null byte, or symlink (`src/artifact-path.js`). The root is the artifact's own directory unless the agent opened the review with `--root`, which must hold the artifact and is canonicalised when the review opens.
- The page under review reading, by `fetch` or any other CORS request, a file under the root that is not a font, or the page itself: only font responses carry `Access-Control-Allow-Origin` (`FONT_HEADERS` in `src/http-guard.js`).
- A note reaching the agent that the reviewer never wrote, or a note attributed to the wrong element.
- The page under review reading a note's instruction or the agent's reply. The pins are drawn inside the frame from what the chrome sends it, which is each note's number, state and the anchor the page itself proposed, never its text (`pinData` in `src/browser/chrome.js`).
- The page under review opening the note card, moving the reviewer's focus, turning Annotate off or sending the queued notes on its own.
  The page sits inside a wrapper frame served under the other loopback name (`localhost` for a chrome on `127.0.0.1`, `pairedHost` in `src/http-guard.js`), and reaches the chrome only through it; the wrapper stamps each message with its own `navigator.userActivation`, which the page can neither read nor forge (`src/browser/wrapper.js`).
  The chrome acts on a proposed target, a pressed pin or a review key (A, and the send key) only when that stamp is active and the frame holds focus (`gesture` in `src/browser/chrome.js`), so the reviewer's own Enter, Add note or Cancel in the note card is not the page's to spend.
  Chromium's trust rests on measured isolation: a click or key in the chrome never activates the wrapper there, and `test/browser.test.js` holds that on every change by having a page try to spend the card's Enter and Cancel, so a Chromium that started sharing either turns the suite red instead of being trusted silently.
  Firefox and Safari keep a click in the chrome out of the page but pass a key on to it; that is measured with Playwright's synthetic input only, and what a real keyboard does there is unmeasured.
  Their trust rests on a gate instead: in every engine `navigator.userAgentData` does not identify as Chromium, an unrecognised one included, the chrome hears nothing from the page for 5 seconds after a key in the chrome, and its help line says so; the engine smoke (`test/engine-smoke.js`) exercises the gate in both, weekly and on the release pull request, which it gates.
  A page acting inside the activation window straight after the reviewer's own click or key in it is the known limit of these checks.
  A page can also call `focus()` on its own elements at any moment, and Chromium then moves the reviewer's focus, and the keys after it, out of the chrome and into the page, with or without a gesture there.
  While the focus is in a note being written, in the note card or in a note edited in the margin, the chrome lays a shield over the page, so a press there lands in the chrome and hands the page the focus on purpose; any other move of the focus from that note into the page is the page's own (`writing` and `shield` in `src/browser/chrome.js`).
  On that move, which the chrome sees as a focus-out from the note that names nothing or the page's frame, the chrome checks a task later whether the focus is in the frame; if it is, the wrapper takes the page out of its document and shows about:blank in its place, the chrome gives the note back the focus once the wrapper says the page is out, and the page comes back through the reload a save uses, at the reviewer's place, once the note is added or cancelled; for the rest of the review the page is also hidden whenever a note is open, with a line saying why (`unload` in `src/browser/chrome.js` and `src/browser/wrapper.js`).
  A Tab the reviewer presses in the note that moves the focus into the page is left alone, and so is a press over the page.
  When the window loses focus while a note field holds it, the chrome records that field at once, and the next task drops the record if the window has the focus again.
  When the window comes back with the page holding the focus, the page's move from the recorded field is unloaded at once (`leftWindow`, `regained` and `takenFrom` in `src/browser/chrome.js`); a press on the shield or a Tab handoff from the note clears that record, so a press that lands as the window returns is a handoff in either order.
  On that path, too, a key typed between the window's return and the wrapper taking the page out can reach the page, and that window is not measured.
  The ordering of a real click that activates the window cannot be expressed in the harness; the test presses over the page after the window is back, not as it returns.
  A page focus() in the same task as the window's blur is not separated from the blur by any test, since the harness cannot order the two in one task.
  A page focus() that lands in the same task as the reviewer's Tab is taken as part of that handoff, since the two cannot be told apart in that task.
  A Tab that leaves the document marks nothing, but the test harness does not drive a Tab out of the document, so no test covers that case.
  A reload that a save would bring waits while a margin edit is open after the page took the focus, and lands once the edit is saved or cancelled.
  It acts on the move itself, not on a report that the hide landed: on the hide design PR 64 shipped, with the frame moved out of the chrome's view first, 144 of 400 out-of-view rounds across runs 37241529478 (macos-15) and 37241527001 (ubuntu-24.04) never got the drawn report the hide waited for, and in 124 of those 400 a key reached the hidden page (transcript "tally: out-of-view probe rounds on the hide design, and the page-out window in CI at 0c5b837").
  `test/browser.test.js` holds that no key typed into the note reaches the page, typed straight after the move and again once the frame holds about:blank, with the frame in view and out of it, on the note the page took the focus from and on a later one.
  The residual is the time from the page's move to the wrapper taking it out, in which a key typed can still reach the page: 5 to 47 ms, median 11 ms, over 126 rounds on Linux, macOS and Windows runners (runs 37247034749, 37247040827, 37247047306 and 37247053785).
  Those runs were on fix head 0c5b837, before the window-return check and the later changes to which moves count as the page's own; the wrapper's `unload` in `src/browser/wrapper.js` is byte-identical since that head, and the chrome's `unload` in `src/browser/chrome.js` has only gained `announced = false;`, a synchronous reset before the same `postMessage`, so the time to the wrapper taking the page out is not changed by it.
  Locally, with six suites running at once, the frame removal failed 0 of 18 runs, with the page out 6 to 68 ms after the move, where navigating the frame instead failed 6 of 12 runs with the note empty and about:blank loading about 300 ms after the first put-back (transcript "tally: navigate design versus frame removal under six suites at once").
  On fix head c66c928, the two hidden-state tests printed the page out 4 ms after the move in each of 10 local rounds (5 with the frame out of view, 5 in view), with no key recorded (transcript "window: the two hidden-state tests on fix head c66c928, 5 local rounds").
  Still open: a page's late refocus can undo a Tab the reviewer pressed in the page (issue 57), and a page can take the focus from a chrome control other than a note field, where it is not seen as taken from a note; a follow-up owns it.
  The engine smoke's unload step (`unloadRound` in `test/engine-smoke.js`) runs five fresh reviews per engine.
  In each, the page calls focus() out of the note with a word typed at once, then the word is typed again once the unloaded line shows, and that second word must land exactly with no key event reaching the page.
  Three engine smoke runs on fix head 5c66d57 (recorded 2026-10-05, labels "engine smoke on fix head 5c66d57, run 1 of 3", "run 2 of 3" and "run 3 of 3") each had both engines unload the page in 5 of 5 rounds.
  Across those runs, once the note held the focus back the asserted word landed exactly, with 0 key events reaching the page in every round of both engines.
  The residual, for a word typed at once before the unload lands, was 0 of 15 WebKit 26.6 rounds and 1 key event in 1 of 15 Firefox 155.0 rounds (run 1, round 2).
  The time from the page's move to the unloaded line was 0 to 2 ms in WebKit 26.6 and 4 to 7 ms in Firefox 155.0.
  On the same head the Chromium browser suite (`test/browser.test.js`) passed 77 of 77 (label "browser suite on fix head 5c66d57").
  The smoke's control step (`keysReachThePage` in `test/engine-smoke.js`), with no note open, reported the page's own 4 key events in each engine in each of those three runs.
  A move of the focus from a note to a chrome control leaves the page alone in the same step, and in Chromium the window losing focus does too (`test/browser.test.js`).
  A press over the page while a note has the focus is not taken for the page's own move (`test/browser.test.js`, in Chromium).
  The engine smoke's press-over-the-page step (`pressOverThePage` in `test/engine-smoke.js`) checks this on every scheduled run.
  A window that comes back with the page holding the focus is measured only in Chromium (`test/browser.test.js`); the engine smoke has no window-return step, so that path is unmeasured in WebKit and Firefox.
- State written where another user on the machine can read it: outside the state directory, with a mode other than `0600` in a `0700` directory on POSIX, or on Windows with any ACL entry beyond the current user (`src/state-dir.js`).
- Any outbound connection opened by the process.
- Markup in an artifact that changes what the injected review script does (`src/inject.js`).
- Resource exhaustion that gets past the caps in `src/limits.js` rather than merely reaching them.

Idle keep-alive connections have no count cap: `server.maxConnections` is unset on purpose, because any local user who can reach the loopback port could fill a count and lock the reviewer out.
They are bounded only by the process's file-descriptor limit and the daemon's idle-out, which closes every connection after 30 minutes with no request (`idleShutdownMs` in `src/limits.js`, overridden by `POINTBACK_IDLE_MS`), and a visible review tab's heartbeat defers that idle-out.
A local user could already hold a connection open without sending a byte: on main such a connection was still open after 45 s on Node 24.20.0, 24.11.1 and 26.10.0, and with this change it stays open after 45 s on Node 26.10.0 and 24.11.1 (`docs/ENGINEERING-NOTES.md`).

Out of scope:

- Anything a process already running as your own user can do. That user can read `~/.pointback/server.json`; the mode bits and the Windows ACL defend against other users on the machine, not against yourself.
- The text of a reviewer's note. `selector`, `tag`, `text`, `target` and `structure` are the untrusted page's own description of what the reviewer pointed at, and `README.md` says so at the point the JSON is described. An agent that executes them as instructions has a defect of its own. `prompt` itself is typed by the reviewer in the chrome, which the artifact cannot reach; a page that puts words in it is in scope, above.
- Denial of service by deliberately reaching the documented caps in `src/limits.js` from a local process. Those are ceilings on a shared daemon, not an authorization boundary.
- Vulnerabilities in your browser, your operating system, or Node itself.
- A dependency advisory with no working path through this code. Report those upstream; do tell us if a version pinned here is the vulnerable one.
- Scanner output with no demonstrated path through this code.

## What a report names

The runtime is Node, so paste `node --version` alongside your operating system.
A report against a copy installed from npm and a report against the `v*` tag of the same version are the same report.
Name the version either way, and `README.md` carries the install paths.
