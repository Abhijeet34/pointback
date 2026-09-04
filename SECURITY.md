# Security policy

pointback is maintained by one person, Abhijeet Halder, in his own time.
There is no security team and no bug bounty.
What follows is what one maintainer can actually do, stated so you can hold him to it.

## Reporting a vulnerability

Report it privately through GitHub, not in a public issue.

Open the repository on GitHub, click the **Security** tab, then **Report a vulnerability**.
That opens a draft security advisory visible only to the maintainer, and it lets the two of you talk in private until there is a fix.
The direct link is <https://github.com/Abhijeet34/pointback/security/advisories/new>.

A useful report names the commit or version you tested, your operating system and `node --version`, the steps that reproduce it, and what an attacker gains at the end.
A proof of concept is welcome and never required.

## What you can expect

- An acknowledgement within 7 days of the advisory being opened.
- An assessment within 30 days of that acknowledgement: whether it reproduces, what the impact is, and whether a fix is coming.
- A fix released as soon as it is ready, and credit in the published advisory if you want it.

Those are targets one person can meet.
If one is going to slip, it gets said in the advisory thread rather than passing in silence.

## Supported versions

Releases are the `v*` tags in this repository, each with a GitHub release under **Releases**.
The newest release is the supported version and nothing older.
A project at this size does not backport, and a support matrix that says otherwise would be a promise nobody keeps.
Fixes land on `main` and ship in the next release, so report against the newest release or against `main`, and say which.

The package is not on npm.
There is no `npm install pointback`; the only way to run it is from a clone of this repository.

## Scope

pointback runs on one person's machine and serves one reviewer.
The server binds `127.0.0.1` only, every API call carries a capability token from `~/.pointback/server.json`, and the process opens no outbound connection at all (`test/egress.test.js` asserts that across the whole slice).
Reports are in scope when they break one of those boundaries.

In scope:

- Reaching the API without the token in `~/.pointback/server.json`: the loopback host check, the origin check, or the constant-time bearer comparison in `src/http-guard.js`, including DNS rebinding onto the bound port.
- Escaping the artifact iframe: the page under review reading the review chrome, calling the API, or recovering the server token from the URL fragment the chrome page is opened with (`src/browser/`).
- Reading or writing a file outside the artifact's own directory through the asset route, by traversal, encoding, separator, null byte, or symlink (`src/artifact-path.js`).
- A note reaching the agent that the reviewer never wrote, or a note attributed to the wrong element.
- State written where another user on the machine can read it: outside the state directory, with a mode other than `0600` in a `0700` directory on POSIX, or on Windows with any ACL entry beyond the current user (`src/state-dir.js`).
- Any outbound connection opened by the process.
- Markup in an artifact that changes what the injected review script does (`src/inject.js`).
- Resource exhaustion that gets past the caps in `src/limits.js` rather than merely reaching them.

Out of scope:

- Anything a process already running as your own user can do. That user can read `~/.pointback/server.json`; the mode bits and the Windows ACL defend against other users on the machine, not against yourself.
- The text of a reviewer's note. `selector`, `tag`, `text`, `target` and `structure` are the untrusted page's own description of what the reviewer pointed at, and `README.md` says so at the point the JSON is described. An agent that executes them as instructions has a defect of its own. `prompt` itself is typed by the reviewer in the chrome, which the artifact cannot reach; a page that puts words in it is in scope, above.
- Denial of service by deliberately reaching the documented caps in `src/limits.js` from a local process. Those are ceilings on a shared daemon, not an authorization boundary.
- Vulnerabilities in your browser, your operating system, or Node itself.
- A dependency advisory with no working path through this code. Report those upstream; do tell us if a version pinned here is the vulnerable one.
- Scanner output with no demonstrated path through this code.
