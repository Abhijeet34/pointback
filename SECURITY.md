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

Nothing has been released yet.
`package.json` is at `0.0.0`, the repository carries no release tag, and the package is not on npm.
Until the first release, `main` is the only supported version, so report against `main` and expect the fix there.

After the first release, the current release line is supported and nothing older.
A project at this size does not backport, and a support matrix that says otherwise would be a promise nobody keeps.

## Scope

pointback runs on one person's machine and serves one reviewer.
The server binds `127.0.0.1` only, every API call carries a capability token from `~/.pointback/server.json`, and the process opens no outbound connection at all (`test/egress.test.js` asserts that across the whole slice).
Reports are in scope when they break one of those boundaries.

In scope:

- Reaching the API without the token in `~/.pointback/server.json`: the loopback host check, the origin check, or the constant-time bearer comparison in `src/http-guard.js`, including DNS rebinding onto the bound port.
- Escaping the artifact iframe: the page under review reading the review chrome, calling the API, or recovering the per-session token from the URL fragment (`src/browser/`).
- Reading or writing a file outside the artifact's own directory through the asset route, by traversal, encoding, separator, null byte, or symlink (`src/artifact-path.js`).
- A note reaching the agent that the reviewer never wrote, or a note attributed to the wrong element.
- State written outside the `0700` directory, or with a mode other than `0600` (`src/state-dir.js`).
- Any outbound connection opened by the process.
- Markup in an artifact that changes what the injected review script does (`src/inject.js`).
- Resource exhaustion that gets past the caps in `src/limits.js` rather than merely reaching them.

Out of scope:

- Anything a process already running as your own user can do. That user can read `~/.pointback/server.json`; the file mode defends against other users on the machine, not against yourself.
- The text of a reviewer's note. `prompt`, `target` and `structure` are reviewer-supplied content from an untrusted page, and `README.md` says so at the point the JSON is described. An agent that executes them as instructions has a defect of its own. A page that can queue a note without the reviewer writing it is a different thing and is in scope, above.
- Denial of service by deliberately reaching the documented caps in `src/limits.js` from a local process. Those are ceilings on a shared daemon, not an authorization boundary.
- Vulnerabilities in your browser, your operating system, or Node itself.
- A dependency advisory with no working path through this code. Report those upstream; do tell us if a version pinned here is the vulnerable one.
- Scanner output with no demonstrated path through this code.
