# pointback

A reviewer points at something on a rendered HTML page an agent produced, and the pointing comes back to the agent as an instruction.

The agent writes a page, runs `pointback plan.html`, and a browser tab opens with the page inside a small review chrome.
Annotate is on when the tab opens, and the reviewer points: at an element, a button or a field by clicking it or Tabbing to it, at a passage by selecting the text, at a table cell by landing on it, at a spot on a chart by clicking it.
Each note is a numbered pin on the page and the same number in the margin; pressing either one leads to the other, and a note not yet sent can be edited where it stands.
The agent runs `pointback poll plan.html` and receives each note as JSON with the element's CSS selector, tag name and visible text, plus the anchor that finds a passage or a cell again after the page has been rewritten.
Once it has acted on a note, the agent runs `pointback reply plan.html 2 --done`, or `--declined` or `--question` with a `--message`, and the reviewer reads the answer on that note.
When the agent rewrites the file, the open tab reloads to the new page and keeps the reviewer where they were reading.
When the reviewer is done, End review closes the loop and sends whatever is still queued in the same step.

Three things it never does: it never sends the page anywhere, it never edits the page on the reviewer's behalf, and it is never a multi-person tool.
One person, one agent, one local file.

The file is HTML or Markdown.
A `.md` or `.markdown` file is rendered with [markdown-it](https://github.com/markdown-it/markdown-it) in the house reading styles, raw HTML in it included, and a note on it also carries the first and last line of the block it points at, so the agent can edit the source without searching for it.
Any other file is refused with a message and exit 1, because a `.txt` served as HTML runs into one paragraph and every note on it would point nowhere useful.

## Requirements

Node 24 or newer, and a browser to review in.
CI runs the suite on `ubuntu-24.04` every pull request, and on `macos-15` and `windows-2025` weekly, on the release pull request, and on every push to `main`.
All three pass the whole suite, with the browser suite driving real Chrome on each.
A weekly smoke runs the core act in WebKit and Firefox as well; "Develop" says how.

## Install

```sh
npm install -g pointback     # puts `pointback` on your PATH
```

Or take it one review at a time, with no global install:

```sh
npx pointback plan.html
```

`parse5` and `markdown-it` are the only runtime dependencies, each pinned to an exact version; `THIRD-PARTY-NOTICES.md` carries their licences and those of the packages they bring.
To work on pointback rather than with it, clone the repository and read "Develop" below.

For Claude Code, [`skills/pointback/SKILL.md`](https://github.com/Abhijeet34/pointback/blob/main/skills/pointback/SKILL.md) teaches the agent the whole loop: open, poll, apply, reply.
It is one file and is not in the npm package; save it as `~/.claude/skills/pointback/SKILL.md`, or under a project's own `.claude/skills/pointback/`.

## Quick start

```sh
pointback plan.html                 # opens the browser, prints the session as JSON
pointback poll plan.html            # blocks until the reviewer sends, then prints the notes
pointback poll plan.html --timeout-ms 30000
pointback reply plan.html 2 --done  # tells the reviewer what became of note 2
pointback end plan.html             # ends the review from the agent's side
pointback plan.html --reopen        # opens a review the reviewer ended
pointback components/sheets/actions.html --root .   # lets the page load assets from anywhere under .
pointback stop                      # stops the background server
```

`poll` waits 60000 ms unless `--timeout-ms` says otherwise, and at most 600000.
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

The page loads its own stylesheets, scripts and images from the review's root, which is the file's own folder unless `--root <dir>` names a wider one that holds it.
A page that links `../components.css` and `../../exports/variables.css`, as a design system's component sheet does, renders unstyled under the default because both files sit above its folder; `--root` at the repository's top makes them reachable.
When the page's markup loads anything from outside the root, the open output lists it under `refused_assets` and its `next_step` says to open again with `--root`, and the tab says the same to the reviewer once, above the status line.
The root is resolved to its real path when the review opens, so a symlinked spelling cannot stretch it, and nothing outside it is served: not by `../`, not by an encoding, not by a symlink inside it that points out.
Every open sets the root again, so opening the file without `--root` goes back to its folder.
The root is also everything the page under review can load, so name the narrowest folder that holds its assets.

Environment: `POINTBACK_STATE_DIR` (default `~/.pointback`), `POINTBACK_PORT` (default the port the last server used, recorded in `server.json`, or an ephemeral one when that is taken), `POINTBACK_NO_OPEN=1` to skip launching the browser, `POINTBACK_IDLE_MS` before an idle server exits (default 30 minutes), `POINTBACK_POLL_REQUEST_MS` how long one request of a poll is held before the CLI asks again (default 240000, at most 240000).

## What comes back

`poll` returns one of four statuses.

| `status`   | What it means                                                                             |
| ---------- | ----------------------------------------------------------------------------------------- |
| `feedback` | `prompts` carries the notes, `structure` the page outline, `reply_with` the reply command |
| `waiting`  | The timeout passed with nothing sent; poll again                                          |
| `ended`    | The review is over, and `ended_by` names who ended it                                     |
| `gone`     | The file was moved or deleted; `file` names where it was, and the exit is 1               |

`end` and `reply` on a moved or deleted file print the same `gone` answer and exit 1, and the open tab says the file is gone.
Notes already sent before the file went are still delivered first.

A final batch arrives as `feedback` with `session_ended: true`, so the last notes are never lost to the end of the session.

Delivery is at-least-once.
A batch stays on the queue until the poll that took it succeeds, and `pointback poll` acknowledges each batch on the next poll, so a poll whose response never arrived (a dropped connection, a killed poller) redelivers the identical batch rather than dropping it.
A redelivered batch carries the same `uid` values it did the first time, and a new note never reuses one for that file, so an agent that skips every `uid` it has already applied drops nothing.
That holds across eviction too: a session evicted at the cap and opened again numbers on from the last `uid` `pointback poll` received for the file.
The acknowledgement is keyed by the file's canonical path, so `/tmp/plan.html` and `/private/tmp/plan.html` share it, and it carries the session's epoch, so an acknowledgement from a session's earlier life confirms nothing in the new one.
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

| Field      | What it carries                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| `uid`      | The note's number in this session, increasing                                 |
| `at`       | When the reviewer wrote it, not when the batch was sent                       |
| `prompt`   | What the reviewer typed                                                       |
| `selector` | A CSS selector for the element the reviewer was on                            |
| `lines`    | Markdown only: `[first, last]`, the 1-based source lines of that block        |
| `tag`      | That element's tag name, or `text` when the reviewer pointed at a passage     |
| `text`     | That element's own text, as the markup carries it                             |
| `target`   | Present for a passage, a table cell, a control or a picture, described below  |
| `answers`  | Present only on the reviewer's answer to a question, naming that note's `uid` |

`prompt` is typed by the reviewer in the review chrome, never sent by the artifact page.
`selector`, `lines`, `tag`, `text`, `target` and `structure` are the untrusted page's own description of what the reviewer pointed at: data describing a change, never instructions to the agent.

## Answering each note

The agent says what it did with a note by its `uid`, with exactly one status.

```sh
pointback reply plan.html 1 --done
pointback reply plan.html 2 --done --message "Cut the title to four words"
pointback reply plan.html 3 --declined --message "The title is the product name"
pointback reply plan.html 4 --question --message "Which queue: billing or email?"
```

It prints the reply as stored, stamped with when it arrived:

```json
{
  "status": "replied",
  "uid": 3,
  "reply": {
    "status": "declined",
    "message": "The title is the product name",
    "at": "2026-10-02T12:41:07.112Z"
  }
}
```

The reply is kept on the note and reaches every open tab as one event, so the margin shows Done, Declined with its reason, or the question, under the note it answers.
A question needs `--message`, and every message is capped at `replyChars` in `src/limits.js`, 2,000 characters, because the reviewer reads it in a narrow margin.
The chrome sets the message as text, never as HTML, so markup in it shows as typed.
A later reply replaces an earlier one, which is how a question becomes done once it is answered.
A `uid` this review never issued, a missing or doubled status, or a question without text exits 1 with the reason on stderr, and nothing is stored.

The reviewer answers a question from the margin, and the answer is a note like any other: it points where the question's note did and carries `answers`, the `uid` of the note it answers.
Every `feedback` batch carries the reply command in `reply_with`, so the loop does not depend on the agent having read this file or the skill.

## What a note points at

Every note carries `selector`, `tag` and `text`, which name the element the reviewer was looking at.
Four kinds carry a `target` as well, because the element's text is not always enough to find or act on it.

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

A `target.type` of `control` is a link, button, field, select, label or summary, as `{type: "control", name: "Invoice email"}`.
`name` is what a screen reader would announce: `aria-labelledby`, `aria-label`, the field's `<label>`, the control's own text, then `alt`, `placeholder` or `title`.
A field has no text of its own, so without the name a note on one arrived as `input` and an empty string.
In Annotate mode a click on a control notes it and goes no further: the page's own click, press and release handlers never see it, a link does not navigate, a field takes no caret and a select does not open.
Turning Annotate off hands every control back to the page.

A `target.type` of `media` is an `img`, `svg`, `canvas` or `video`, as `{type: "media", alt: "Weekly trend", src: "trend.svg", x: 50, y: 20, width: 200, height: 80}`.
An image carries its `alt` and its `src` as the markup wrote them; any other picture carries its accessible `name` when it has one.
A click adds `x` and `y`, the point in CSS pixels from the picture's top left, beside the `width` and `height` it was drawn at, so a point on a chart scales to its `viewBox` or its data; a picture reached by keyboard has no point.
A click on a bar or a label inside an `svg` notes the whole `svg`, because an inner `<text>` element would otherwise arrive with the tag `text`, which already means a passage.

`structure` is an outline of the page as the reviewer saw it: headings, sections, tables, lists, figures and code blocks, each addressed relative to the one above it, nothing that was not rendered, and capped at 2,000 characters.
On `test/fixtures/plan.html` it is 413 bytes, where the shape it replaces (every element to a depth of six with 80 characters of its text) is 2,470 bytes on the same page and also carries the contents of a `hidden` container the reviewer never saw.
That outline lands in an agent's context window, so it is bounded on purpose, and it comes only when the agent does not already have it.
`pointback poll` sends it with a session's first batch and again only when it differs from the last one it delivered, and the long `next_step` that explains every field likewise comes once per session; later batches carry a one-line `next_step`.
The poll cursor in the state directory records what was delivered, so a batch whose response was lost is redelivered whole.
Measured by `test/cli.test.js` on three one-note batches: 1,624 bytes for the first, 445 for a second at the same outline, 569 for a third whose outline changed.

## By keyboard

Annotate mode gives each block of content a Tab stop, so the product's central act needs no mouse: a heading, a paragraph, a list item, a table cell, a code block, a picture.
An inline run such as a bold phrase or a link rides with its block, a container of other blocks is not a stop, and the page's own links and controls keep the stops they already had.
The first version gave every element with text of its own a stop, which put 1,794 on an 81 KB report rendered from Markdown; the same report now has 1,012, plus its 91 links, against 1,243 blocks.
Tab to a block, press Enter or Space to open the card, type, and press Enter to add the note; Escape closes the card and returns focus to the block you came from.
Enter on a focused link or control notes it, as a click does.
Hold Shift and press an arrow key to grow a real selection a word at a time inside the focused block, then Enter to note that passage rather than the whole block.
H moves to the next heading and Shift+H to the one before, A turns Annotate off and on, and Ctrl+Enter (⌘Enter on a Mac) adds the note being written and sends; the help line in the margin lists them.
None of them fires in a field the reviewer is typing in, or on a key the page under review has already handled.
`test/browser.test.js` walks it: five Shift+ArrowRight on the first paragraph, Enter, type, Enter, then five Tab stops to the owner of the first step and Enter again, with no mouse event anywhere in between, and a second case walks every stop of the plan, jumps by heading and sends by key.
The pins are buttons after the page's own content, each named by its number and state, such as "Note 2, sent"; Enter on one moves focus to its note in the margin, and Enter on a margin note's number scrolls the page to its target and rings its pin.

## While the review is open

The tab holds one WebSocket, `/api/<key>/events`, and the server sends a JSON message on it per event.
It was first a held `fetch` response, and a browser gives one host six HTTP connections, so the sixth review tab could not add a note and the seventh never loaded; a WebSocket does not count against those six.
A browser cannot put a header on a WebSocket, so the capability token travels as the offered subprotocol `bearer.<token>` and the server answers with `events`.
Every call the tab makes over HTTP gives up after 10 seconds and says so, so no add, edit or send leaves the reviewer waiting on nothing.
It carries seven things.

- **Live reload.** The server watches the artifact's directory, not its inode, so an editor's write-and-rename save still counts, and a burst of writes inside 100 ms is one change. Each change numbers a new revision; the tab reloads the artifact at that revision and puts the element the reviewer was reading back where it was on screen, so a section added above it does not push their line down the page. A reload that would interrupt a half-typed note waits until the note is added.
- **Presence.** `waiting` when no poll is attached, `listening` while one is and for `pollGraceMs` (2 s) after one that ended with nothing, so the requests a long poll is made of read as one wait, `working` from the moment a poll takes a batch until the agent has replied to every note in it or the file goes. Working is bounded by `workingMaxMs` in `src/limits.js`, so an agent that took the feedback and never came back stops showing as working after three minutes. It never locks Send: a note sent while the agent works queues behind the batch it holds and arrives on its next poll.
- **Unsent notes.** A note is kept by the server the moment the reviewer adds it, so closing the tab, reloading it or restarting the daemon loses nothing, and every tab on the review shows the same list. Send hands every unsent note to the agent as one batch, which is why at most `promptsPerRequest` of them wait at once.
- **Replies.** The agent's answer to a note lands on that note as it is given, and the status line says when the agent has asked a question or answered every note. Every connect carries the sent notes with their replies, so a tab that was away catches up.
- **The handover.** Opening the file again while a tab shows the review opens nothing new, and the agent is told the review is already open; if that open names a different `--root`, the tab follows to the address the new root gives it rather than reloading into a 404. A second tab the reviewer opens themselves owns the artifact view; the older one is told the moment it happens and offers to take the review back, rather than finding out at the next save.
- **A gone file.** A file moved or deleted under review stops the page: Annotate, Send and End review turn off and the notice says why, and the file coming back turns Annotate on again, if the reviewer had wanted it on, and reloads the review where it was.
- **The end.** Ending from the tab confirms first, and when notes are queued the confirming action is to send them. The agent's own `end` leaves a queue sendable, because notes nobody can deliver are worse than a queue the agent picks up on its next check.

When the stream drops, the header says the tab is not connected and the notice says what happens next, once each; Send turns off until it is back, and a note being written stays in its card with Add note held until then.
It keeps trying, because a daemon that idled out or was stopped comes back at the agent's next command on the same port with the same token, and the tab picks the review up from there.
If something else took that port in the meantime and answers there, the tab cannot prove it holds the token it was given, so it says once that it is disconnected and promises no reconnection; running the command on the file again opens a fresh tab with the notes in it.

The frame can leave the page under review too: a link followed with Annotate off, or an address with nothing at it, which the server answers inside a review with a short page in the house reading styles rather than JSON.
Only the page under review announces itself to the chrome, so a page that loads without doing so is covered, where the reviewer is looking, by a notice saying the frame went to a page that is missing or is not the file, with a button back to it.

The cap on live tabs is `eventStreams` in `src/limits.js`, beside the caps on sessions, prompts and open polls.

## How it holds together

The first CLI call starts a detached server bound to `127.0.0.1` only and records its port and a random capability token in `~/.pointback/server.json`, readable by the owner alone.
A restarted server takes the same port and token again while that port is free, which is what lets an open tab reconnect, and mints a fresh token whenever it has to take another port.
Because the token outlives the process, whatever holds a dead daemon's port must never receive it: the CLI and the tab present it only to a server that first answers a fresh challenge keyed with it (`tokenProof` in `src/http-guard.js`).
There is one exception: a daemon from 0.1.4 or earlier cannot answer the challenge and still has to stop, so to a server on the recorded port that answers as `{"app":"pointback"}` without the proof, the CLI sends the token once on `POST /shutdown` and then retires it in `server.json`, and the next daemon mints a fresh one (`stopServer` in `src/client.js`).
A process squatting the port with that answer receives a token that no running daemon accepts.
Every API call, from the CLI or from the chrome page, carries that token; the browser receives it in the URL fragment, which never reaches a server log.
A session is keyed by a hash of the file's canonical path, but that key opens nothing: the artifact bytes are served under a second random per-session token, and the store is a `Map`, so no key can resolve to an inherited property.
The page under review runs in a sandboxed iframe with an opaque origin, framed by a wrapper the daemon serves under the other loopback name (`pairedHost` in `src/http-guard.js`).
The page cannot read the chrome, cannot call the API, and reaches the chrome only through that wrapper, which relays each message stamped with its own `navigator.userActivation` rather than the page's; the chrome acts on a proposed target, a pin or a review key only while that stamp is active (`docs/THREAT-MODEL.md`).
The review script is inserted into the artifact as a DOM node through a real HTML parser, so nothing in the page's own markup can swallow or reshape it.
Assets resolve within the review's root through a path check that survives encoded traversal, backslashes, unicode lookalikes, null bytes, absolute paths and symlink escape.
A font (`.woff2`, `.woff`, `.ttf`, `.otf`) is the one asset served with `Access-Control-Allow-Origin`, because the opaque origin makes every `@font-face` load a CORS request; any other file under the root, and the API, stay unreadable to the page's own script, so a stray `.env` beside the artifact cannot be read and sent out.
Each session is its own file under `sessions/` in the state directory, so a file save rewrites the one review it belongs to rather than every review the daemon holds.
`npm run bench` times exactly that save at 200 notes a session: when every session shared one `state.json` it wrote 0.22 MB in about 0.4 ms with 1 session held and 14.05 MB in about 17.5 ms with 64, and now it writes 0.21 MB in about 0.4 ms at every count from 1 to 64.
A `state.json` from an earlier version is split on the first start, and renamed to `state.json.migrated` only once every session in it reads back from its own file.
State is written to a temporary file and renamed, a temporary file a crash left behind is removed on the next start, and nothing but the owning user can read it.
POSIX says that in the mode bits, `0600` in a `0700` directory.
Windows has no such bits, so the state directory's ACL is reset to a single full-control entry for the current user and every file written inside inherits it.

A review is a bounded thing that ends, not state that piles up.
The daemon idles out after `POINTBACK_IDLE_MS` of no activity, and a review tab keeps it alive only while the reviewer is on it: the tab heartbeats while its page is visible and stops when it is hidden, so a review left open and walked away from releases the process rather than pinning it open for good.
Sessions are capped at `sessions` in `src/limits.js`; opening past the cap disposes the least-recently-active session, an ended review before a running one, so `sessions/` holds at most that many files no matter how many files have been reviewed.
A session with a tab open on it, a poll attached, or notes not yet sent or received is never the one disposed; when every session held is one of those, the new open is refused and names those three causes, and `skills/pointback/SKILL.md` gives the way out for each.
After a hundred reviews on a long-lived machine, then, there is one small loopback daemon that exits on its own when idle, and a `sessions/` directory bounded to the most recent sessions, each holding that session's path and the notes sent in it.

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
One case runs at 390x844, where the margin becomes a band under the page: it fails if anything in the chrome scrolls sideways or if Annotate, End review, the note card, the note or Send is off screen or covered where a press would land.
The artifact runs in a sandboxed, opaque-origin iframe, which Chromium puts in a process of its own and leaves out of the page's frame tree, so the test reads its DOM through an auto-attached session and drives it with page-level input.
A dispatched press, path and release does make a real DOM selection: the test asserts that with annotate off, before any passage assertion leans on it.
It finds Brave, Chrome or Chromium in the usual places, or takes `POINTBACK_BROWSER=/path/to/binary`; `POINTBACK_BROWSER=none` skips it loudly.

The CLI opens the reviewer's default browser, which is Safari on an unconfigured Mac, so Chromium alone is not the whole audience.
`npm run smoke -- webkit firefox` runs the core act in both engines: open the fixture through the CLI, point at the title, write a note, send it, and poll it back.
It then has a hostile page try to spend the note card's Enter, which exercises the gate those engines rely on (`docs/THREAT-MODEL.md`).
The `engines` job in `.github/workflows/cross-platform.yml` runs it every Monday, WebKit on `macos-15` and Firefox on `ubuntu-24.04`, and names the engine and its version in the job summary; it skips when `ci.yml` or `release.yml` calls that workflow, so a browser release cannot hold a tag.
The DevTools harness above cannot reach either engine: WebKit speaks its own inspector protocol and Firefox removed its CDP support in Firefox 141 in favour of WebDriver BiDi.
Playwright can, through `playwright-core`, one package with no dependencies and no install script; it fetches nothing until `npx playwright-core install webkit firefox` asks it to.
It is a dev dependency used by `test/engine-smoke.js` alone, so the Chromium suite keeps its own harness and the tarball is unchanged.
Playwright's WebKit is the engine Safari is built on rather than Safari itself; driving real Safari takes `safaridriver`, which has no headless mode, and Firefox would then need `geckodriver` beside it.

The product name lives in `package.json` and is derived everywhere else through `src/identity.js`; `test/identity.test.js` fails if it appears anywhere else under `src/`.
The mark is `src/browser/icon.svg`, a point and the return that carries it back, drawn on a 16px grid so the tab icon stays crisp; it follows the tab strip's light or dark scheme, and the same paths are inlined in `chrome.html` beside the wordmark.
`src/browser/icon-32.png` is the fallback for browsers that take no SVG tab icon, rendered from the SVG with `rsvg-convert -w 32 -h 32 src/browser/icon.svg -o src/browser/icon-32.png`; regenerate it whenever the SVG changes.
The chrome is built from the house design system, [halderworks-design](https://github.com/Abhijeet34/halderworks-design): its buttons, switch, popover, dialog, notes, pins, segmented control and text areas are the house components, and `chrome.css` lays them out with the house roles and scales alone; its only colour literal is `--paper`, which stands in for the page under review until that page paints its own ground.
Every size is rem on the house ramp, so `data-text-size` on `<html>` (13 to 22 px at the root) grows the whole chrome.
The bar's Aa button opens the five steps, S to XL and XXL, in a house popover, and the size reaches a rendered Markdown page, the review's own, while an HTML page keeps the sizes its author set; this browser keeps the choice for the next review, and each step is a share of the browser's own default size, so a reviewer who raised that keeps the raise.
The faces are Archivo for the interface, IBM Plex Mono for file names, and Literata for a rendered Markdown page's prose, served by the daemon from `src/browser/house/fonts/` with their OFL texts, so a review makes no request off loopback.
The pins inside the page under review cannot load the chrome's sheets, so `sdk.js` draws them with the house pin's shape and its dark roles as literals.
Its brand ramps, `roles.css`, `scales.css`, `components.css`, `radiogroup.js` (the segmented control's arrow keys) and the three faces are vendored byte for byte into `src/browser/house/`, and `src/browser/house/pin.json` records the commit they came from and each file's SHA-256; `.gitattributes` keeps that directory out of line-ending normalisation, because IBM Plex Mono's `OFL.txt` is CRLF upstream.
A copy rather than a package, because the house publishes no package and the chrome makes no request off the daemon; a commit rather than a branch, because a look that changes when someone else merges is not one anybody reviewed.
`test/house.test.js` fails if a vendored file differs from its recorded digest, so a hand edit there is drift: change the house and move the pin with `node scripts/sync-house.js ../halderworks-design`, which refuses a checkout with an uncommitted change to any file it vendors.
Dark is pinned by `data-theme="dark"` on `chrome.html`; the light theme resolves from the same roles and is deliberately not offered.
`docs/GIT-WORKFLOW.md` covers how a change reaches `main`, how a release is cut, and what npm does and does not permit when one has to be withdrawn.

## Contributing, security and support

[`CONTRIBUTING.md`](https://github.com/Abhijeet34/pointback/blob/main/CONTRIBUTING.md) says what a pull request needs, and `AGENTS.md` holds this project's own build and test rules.
Report a vulnerability privately through [the repository's Security tab](https://github.com/Abhijeet34/pointback/security/advisories/new), and never in a public issue.
[`SECURITY.md`](https://github.com/Abhijeet34/pointback/blob/main/SECURITY.md) carries the route and the response times one maintainer will actually meet, and [`docs/THREAT-MODEL.md`](https://github.com/Abhijeet34/pointback/blob/main/docs/THREAT-MODEL.md) says what is in scope.
[`SUPPORT.md`](https://github.com/Abhijeet34/pointback/blob/main/SUPPORT.md) says where a bug report, a feature request or a question goes, and [`CODE_OF_CONDUCT.md`](https://github.com/Abhijeet34/pointback/blob/main/CODE_OF_CONDUCT.md) applies to every project space.

## Licence

Apache-2.0.
The full text is in `LICENSE`, and `THIRD-PARTY-NOTICES.md` lists the licences of the dependencies shipped with the package.
