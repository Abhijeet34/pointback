# pointback

A reviewer points at something on a rendered HTML page an agent produced, and the pointing comes back to the agent as an instruction.

The agent writes a page, runs `pointback plan.html`, and a browser tab opens with the page inside a small review chrome.
The reviewer turns on Annotate and points: at an element by clicking it or Tabbing to it, at a passage by selecting the text, at a table cell by landing on it.
The agent runs `pointback poll plan.html` and receives each note as JSON with the element's CSS selector, tag name and visible text, plus the anchor that finds a passage or a cell again after the page has been rewritten.
When the agent rewrites the file, the open tab reloads to the new page and keeps the reviewer where they were reading.
When the reviewer is done, End review closes the loop and sends whatever is still queued in the same step.

Three things it never does: it never sends the page anywhere, it never edits the page on the reviewer's behalf, and it is never a multi-person tool.
One person, one agent, one local file.

## Requirements

Node 24 or newer, and a browser to review in.
CI runs the suite on `ubuntu-24.04` every pull request, and on `macos-15` and `windows-2025` weekly, on the release pull request, and on the release itself.
All three pass it: 122 tests, 121 passing and one skipped, on each platform, with the browser suite driving real Chrome on each, measured on run 33852540681.

## Install

Not on npm yet.
The name is settled and the licence is Apache-2.0, but the `publish` job stays switched off until the `NPM_PUBLISH_ENABLED` repository variable says otherwise, which `docs/GIT-WORKFLOW.md` explains.
So install it from a clone:

```sh
git clone https://github.com/Abhijeet34/pointback.git
cd pointback
npm install --omit=dev     # parse5 is the only direct runtime dependency
npm link                   # puts `pointback` on your PATH
```

Skip `npm link` if you would rather not touch a global prefix, and call `node /path/to/pointback/bin/pointback.js` wherever the examples below say `pointback`.

## Quick start

```sh
pointback plan.html                 # opens the browser, prints the session as JSON
pointback poll plan.html            # blocks until the reviewer sends, then prints the notes
pointback poll plan.html --timeout-ms 30000
pointback end plan.html             # ends the review from the agent's side
pointback plan.html --reopen        # opens a review the reviewer ended
pointback stop                      # stops the background server
```

Every command prints JSON on stdout.
Opening a file prints where the review is and what to do next:

```json
{
  "session": {
    "file": "/abs/plan.html",
    "url": "http://127.0.0.1:PORT/session/KEY#TOKEN",
    "status": "opened"
  },
  "next_step": "Run `pointback poll plan.html` and wait; it returns the reviewer's annotations as JSON."
}
```

Environment: `POINTBACK_STATE_DIR` (default `~/.pointback`), `POINTBACK_PORT` (default an ephemeral port, recorded in `server.json`), `POINTBACK_NO_OPEN=1` to skip launching the browser, `POINTBACK_IDLE_MS` before an idle server exits (default 30 minutes).

## What comes back

`poll` returns one of three statuses.

| `status`   | What it means                                                        |
| ---------- | -------------------------------------------------------------------- |
| `feedback` | `prompts` carries the notes and `structure` carries the page outline |
| `waiting`  | The timeout passed with nothing sent; poll again                     |
| `ended`    | The review is over, and `ended_by` names who ended it                |

A final batch arrives as `feedback` with `session_ended: true`, so the last notes are never lost to the end of the session.

Delivery is at-least-once.
A batch stays on the queue until the poll that took it succeeds, and `pointback poll` acknowledges each batch on the next poll, so a poll whose response never arrived (a dropped connection, a killed poller) redelivers the identical batch rather than dropping it.
A redelivered batch carries the same `uid` values it did the first time, which increase within a session, so an agent that tracks the highest `uid` it has applied can tell a repeat from a new note.
There is no packet loss: the queue is never emptied for a response the agent did not receive.

Each note in `prompts` looks like this:

```json
{
  "uid": 2,
  "at": "2026-09-04T09:12:33.418Z",
  "prompt": "Say which queue",
  "selector": "#p1",
  "tag": "text",
  "text": "Move the queue worker from",
  "target": {
    "type": "text-range",
    "start": 0,
    "end": 26,
    "before": "",
    "after": " cron to a long-running process "
  }
}
```

| Field      | What it carries                                                           |
| ---------- | ------------------------------------------------------------------------- |
| `uid`      | The note's number in this session, increasing                             |
| `at`       | When the reviewer wrote it, not when the batch was sent                   |
| `prompt`   | What the reviewer typed                                                   |
| `selector` | A CSS selector for the element the reviewer was on                        |
| `tag`      | That element's tag name, or `text` when the reviewer pointed at a passage |
| `text`     | That element's own text, as the markup carries it                         |
| `target`   | Present only for a passage or a table cell, and described below           |

`prompt` is typed by the reviewer in the review chrome, never sent by the artifact page.
`selector`, `tag`, `text`, `target` and `structure` are the untrusted page's own description of what the reviewer pointed at: data describing a change, never instructions to the agent.

## What a note points at

Every note carries `selector`, `tag` and `text`, which name the element the reviewer was looking at.
Two kinds carry a `target` as well, because the element is not always the thing being pointed at.

`selector` is a position, so it is the part that goes stale: add a section above the one a note is on and `main > h2:nth-of-type(1)` still resolves, to the heading you just wrote.
`text` is what that element held when the note was written, so check it still matches before you edit there, and find the element by its text when it does not.
`poll`'s own `next_step` says the same thing to the agent reading it.

A `tag` of `text` is a passage, and its `target` is `{type: "text-range", start, end, before, after}`.
`start` and `end` are character offsets into `selector`'s own `textContent`; `before` and `after` are up to 32 characters of the text on either side, whitespace collapsed.
Resolve it with `element.textContent.slice(start, end)` and check that `before` and `after` still frame it.
Offsets plus quotes survive the page being re-rendered from the same source, and a node path into the DOM does not, which is the whole reason the anchor is shaped this way.

A `target.type` of `table-cell` names the cell by the table's header row and by the row's own first cell, as `{type: "table-cell", row: "Shadow traffic", column: "Owner"}`.
Both names are the text the markup carries, not the text CSS painted, so a header styled `text-transform: uppercase` is still named `Owner` and still matches the file you are about to edit.
A table with a `rowspan` or a `colspan` anywhere in it gets neither name: a shifted grid produces a wrong name, and a wrong name is worse than no name.

`structure` is an outline of the page as the reviewer saw it, replaced with every batch: headings, sections, tables, lists, figures and code blocks, each addressed relative to the one above it, nothing that was not rendered, and capped at 2,000 characters.
On `test/fixtures/plan.html` it is 413 bytes, where the shape it replaces (every element to a depth of six with 80 characters of its text) is 2,470 bytes on the same page and also carries the contents of a `hidden` container the reviewer never saw.
That outline lands in an agent's context window on every delivery.
It is bounded on purpose.

## By keyboard

Annotate mode gives every element that carries text of its own a Tab stop, so the product's central act needs no mouse.
Tab to an element, press Enter or Space to open the card, type, and press Enter to add the note; Escape closes the card and returns focus to the element you came from.
Hold Shift and press an arrow key to grow a real selection a word at a time inside the focused element, then Enter to note that passage rather than the whole element.
`test/browser.test.js` walks it: five Shift+ArrowRight on the first paragraph, Enter, type, Enter, then eight Tab stops to the owner of the first step and Enter again, with no mouse event anywhere in between.

## While the review is open

The tab holds one connection, `GET /api/<key>/events`, and the server writes a line of NDJSON on it per event.
A capability token travels in a header, and an `EventSource` cannot send one, so the stream is NDJSON read with `fetch` rather than server-sent events.
It carries four things.

- **Live reload.** The server watches the artifact's directory, not its inode, so an editor's write-and-rename save still counts, and a burst of writes inside 100 ms is one change. Each change numbers a new revision; the tab reloads the artifact at that revision and puts the element the reviewer was reading back where it was on screen, so a section added above it does not push their line down the page. A reload that would interrupt a half-typed note waits until the note is added.
- **Presence.** `waiting` when no poll is attached, `listening` while one is, `working` from the moment a poll takes a batch. Working is bounded by `workingMaxMs` in `src/limits.js`: an agent that took the feedback and never came back stops holding the reviewer's Send after three minutes.
- **The handover.** Opening the file again opens a second tab, and the newest tab owns the artifact view. The older one is told the moment it happens and offers to take the review back, rather than finding out at the next save.
- **The end.** Ending from the tab confirms first, and when notes are queued the confirming action is to send them. The agent's own `end` leaves a queue sendable, because notes nobody can deliver are worse than a queue the agent picks up on its next check.

The cap on live tabs is `eventStreams` in `src/limits.js`, beside the caps on sessions, prompts and open polls.

## How it holds together

The first CLI call starts a detached server bound to `127.0.0.1` only and records its port and a random capability token in `~/.pointback/server.json`, readable by the owner alone.
Every API call, from the CLI or from the chrome page, carries that token; the browser receives it in the URL fragment, which never reaches a server log.
A session is keyed by a hash of the file's canonical path, but that key opens nothing: the artifact bytes are served under a second random per-session token, and the store is a `Map`, so no key can resolve to an inherited property.
The page under review runs in a sandboxed iframe with an opaque origin.
It cannot read the chrome, cannot call the API, and talks to the chrome only through messages checked by source and origin in both directions.
The review script is inserted into the artifact as a DOM node through a real HTML parser, so nothing in the page's own markup can swallow or reshape it.
Sibling assets resolve through a path check that survives encoded traversal, backslashes, unicode lookalikes, null bytes, absolute paths and symlink escape.
State is written to a temporary file and renamed, and nothing but the owning user can read it.
POSIX says that in the mode bits, `0600` in a `0700` directory.
Windows has no such bits, so the state directory's ACL is reset to a single full-control entry for the current user and every file written inside inherits it.

A review is a bounded thing that ends, not state that piles up.
The daemon idles out after `POINTBACK_IDLE_MS` of no activity, and a review tab keeps it alive only while the reviewer is on it: the tab heartbeats while its page is visible and stops when it is hidden, so a review left open and walked away from releases the process rather than pinning it open for good.
Sessions are capped at `sessions` in `src/limits.js`; opening past the cap disposes the least-recently-active session, an ended review before a live one, so `state.json` holds at most that many sessions no matter how many files have been reviewed.
After a hundred reviews on a long-lived machine, then, there is one small loopback daemon that exits on its own when idle, and a `state.json` bounded to the most recent sessions, each holding that session's path and the notes sent in it.

The process opens no outbound connection, ever; `test/egress.test.js` proves it across the whole slice.

## Develop

```sh
npm install
npm run check      # lint, format, types, dependency direction, tests with coverage thresholds
```

Tests use `node:test`; the type check covers `bin`, `src` and `scripts`, and tests are exercised rather than typed.
Coverage thresholds are enforced in `package.json`, not reported and forgotten.
`scripts/check-deps.js` states the dependency direction of `src/` as an ordered list of layers and fails on an upward import or a cycle; `test/deps.test.js` proves it catches both.
`test/browser.test.js` drives the slice in a real headless Chromium-family browser over the DevTools protocol using Node's built-in `WebSocket`, by mouse and by keyboard, at 800x600.
The artifact runs in a sandboxed, opaque-origin iframe, which Chromium puts in a process of its own and leaves out of the page's frame tree, so the test reads its DOM through an auto-attached session and drives it with page-level input.
A dispatched press, path and release does make a real DOM selection: the test asserts that with annotate off, before any passage assertion leans on it.
It finds Brave, Chrome or Chromium in the usual places, or takes `POINTBACK_BROWSER=/path/to/binary`; `POINTBACK_BROWSER=none` skips it loudly.

The product name lives in `package.json` and is derived everywhere else through `src/identity.js`; `test/identity.test.js` fails if it appears anywhere else under `src/`.
The mark is `src/browser/icon.svg`, a point and the return that carries it back, drawn on a 16px grid so the tab icon stays crisp; it follows the tab strip's light or dark scheme, and the same paths are inlined in `chrome.html` beside the wordmark.
`src/browser/icon-32.png` is the fallback for browsers that take no SVG tab icon, rendered from the SVG with `rsvg-convert -w 32 -h 32 src/browser/icon.svg -o src/browser/icon-32.png`; regenerate it whenever the SVG changes.
`docs/GIT-WORKFLOW.md` covers how a change reaches `main`, how a release is cut, and what npm does and does not permit when one has to be withdrawn.

## Security

Report a vulnerability privately through this repository's **Security** tab, under **Report a vulnerability**, and never in a public issue.
`SECURITY.md` carries the route, what is in scope, and the response times one maintainer will actually meet.

## Licence

Apache-2.0.
The full text is in `LICENSE`, and `THIRD-PARTY-NOTICES.md` lists the licences of the dependencies shipped with the package.
