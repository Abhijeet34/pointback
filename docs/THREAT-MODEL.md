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
- A note reaching the agent that the reviewer never wrote, or a note the chrome attributes to a target other than the one the page proposed for the reviewer's own gesture.
  Which element that target names, and how the page describes it, is the page's own account, out of scope below.
- The page under review reading a note's instruction or the agent's reply. The pins are drawn inside the frame from what the chrome sends it, which is each note's number, state and the anchor the page itself proposed, never its text (`pinData` in `src/browser/chrome.js`).
- The page under review opening the note card, moving the reviewer's focus, turning Annotate off or sending the queued notes on its own.
  The page sits inside a wrapper frame served under the other loopback name (`localhost` for a chrome on `127.0.0.1`, `pairedHost` in `src/http-guard.js`), and reaches the chrome only through it; the wrapper stamps each message with its own `navigator.userActivation`, which the page can neither read nor forge (`src/browser/wrapper.js`).
  The chrome acts on a proposed target, a pressed pin or a review key (A, and the send key) only when that stamp is active and the frame holds focus (`gesture` in `src/browser/chrome.js`), so the reviewer's own Enter, Add note or Cancel in the note card is not the page's to spend.
  Chromium's trust rests on measured isolation: a click or key in the chrome never activates the wrapper there, and `test/browser.test.js` holds that on every change by having a page try to spend the card's Enter and Cancel, so a Chromium that started sharing either turns the suite red instead of being trusted silently.
  Firefox and Safari keep a click in the chrome out of the page but pass a key on to it; that is measured with Playwright's synthetic input only, and what a real keyboard does there is unmeasured.
  Their trust rests on a gate instead: in every engine `navigator.userAgentData` does not identify as Chromium, an unrecognised one included, the chrome hears nothing from the page for 5 seconds after a key in the chrome, and its help line says so; the engine smoke (`test/engine-smoke.js`) exercises the gate in both, weekly and on the release pull request, which it gates.
  A target the chrome drops is answered as a closed card, so the page lets go of it and hears the reviewer's next click (`test/engine-smoke.js`, `clickInsideTheGate`); the answer tells a page nothing a second proposal would not, and the smoke's Enter step has the page propose again on every answer until well past the gate.
  On the fix such a page made 582555 proposals in Firefox 155.0 and 353149 in WebKit 26.6 in the 31 s after the card's Enter, with no input in that time, and none opened the card or sent a note (transcript "security probe on fix a764f6d: page retrying on every answer, 31 s after Enter").
  A page acting inside the activation window straight after the reviewer's own click or key in it is the known limit of these checks.
  A page can also call `focus()` on its own elements at any moment, and Chromium, WebKit and Firefox then move the reviewer's focus, and the keys after it, out of the chrome and into the page, with or without a gesture there.
  So no note gets the focus while the page is in the wrapper: before the note card, an answer or a margin edit takes the focus, the wrapper takes the page out of its document and shows about:blank in its place, and the note gets the focus only once the wrapper says the page is out (`intoNote` and `unload` in `src/browser/chrome.js`, `unload` in `src/browser/wrapper.js`).
  Each answer names the request it answers, so an answer to an earlier unload never hands a later note the focus while the page could still be in the wrapper.
  While a note is open there is no page document to take the focus or hear a key, whatever the reviewer does in the chrome meanwhile, and the frame is covered by a line saying why.
  The page comes back through the reload a save uses, at the reviewer's place, once the note is added or cancelled, and a note made by keyboard gives its element the focus back in the page loaded then, or in WebKit, which lets a page move the focus only inside the reviewer's own input, at the reviewer's next Tab (`init` in `src/browser/sdk.js`).
  That reload resets whatever the page held in memory, such as form input or a step reached in an interactive prototype, after every note: the cost of the isolation.
  A page that took the focus while no note is open holds it as the reviewer's own choice of where to type, and its own keys are the page's.
  `test/browser.test.js` holds, in Chromium, that a page calling focus() every 20 ms from before the note opens hears no key of a note in the card, an answer, a later note or a margin edit, and none while a note is open and the focus is on a chrome control or on nothing.
  The engine smoke (`unloadRound` and `oneShotRound` in `test/engine-smoke.js`) asserts the same in WebKit and Firefox in five fresh reviews each: a word typed from the moment the note has the focus lands whole, and no key event reaches a page that calls focus() every 20 ms, or once, 300 ms after it loses the focus.
  Before this, from 0.1.7, the chrome unloaded the page only once it saw the page take the focus, and a key typed at that moment could still reach the page in every engine.
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
