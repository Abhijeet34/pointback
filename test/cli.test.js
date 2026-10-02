import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { name, version } from "../src/identity.js";
import { limits } from "../src/limits.js";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";
import { assertPrivate } from "./helpers/private.js";

const lab = isolatedEnv();
after(() => lab.stop());

test("--version and --help answer without touching the state directory", async () => {
  assert.equal((await cli(["--version"], lab.env)).stdout.trim(), version);
  const help = await cli(["--help"], lab.env);
  assert.match(help.stdout, new RegExp(`^${name} ${version}`));
  assert.equal((await cli([], lab.env)).stdout, help.stdout);
});

test("open starts a detached server, records a session and returns a token-bearing url", async () => {
  const started = Date.now();
  const opened = await cli([fixture], lab.env);
  const elapsed = Date.now() - started;
  assert.equal(opened.code, 0, opened.stderr);
  const out = opened.json();
  const info = lab.serverInfo();
  assert.equal(out.session.status, "opened");
  assert.equal(
    out.session.url,
    `http://127.0.0.1:${info.port}/session/${out.session.url.match(/session\/([0-9a-f]{16})/)[1]}#${info.token}`,
  );
  assert.match(out.next_step, /poll/);
  assertPrivate(lab.dir, 0o700);
  for (const file of readdirSync(lab.dir)) assertPrivate(join(lab.dir, file), 0o600);
  // Reported, not asserted. What a millisecond budget on a shared CI runner measures is the
  // runner: `cli()` already kills and names a command that has not exited in 30 s, which is
  // the bound that catches an `open` that hangs. A budget between the two only fails when
  // windows-2025 is busy, and this suite has spent six point fixes learning that.
  console.log(`cli: open returned in ${elapsed} ms`);
  const again = await cli(["open", fixture, "--no-open"], lab.env);
  assert.equal(again.json().session.url, out.session.url);
  assert.equal(lab.serverInfo().pid, info.pid, "the running server is reused");
});

test("poll waits for feedback and returns it with its target intact", async () => {
  const info = lab.serverInfo();
  const key = (await cli([fixture], lab.env))
    .json()
    .session.url.match(/session\/([0-9a-f]{16})/)[1];
  const polling = cli(["poll", fixture, "--timeout-ms", "10000"], lab.env);
  await new Promise((r) => setTimeout(r, 400));
  const res = await fetch(`http://127.0.0.1:${info.port}/api/${key}/prompts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
      origin: `http://127.0.0.1:${info.port}`,
    },
    body: JSON.stringify({
      prompts: [{ prompt: "Shorter", selector: "#title", tag: "h1", text: "Rollout" }],
    }),
  });
  assert.equal(res.status, 200);
  const polled = await polling;
  assert.equal(polled.code, 0, polled.stderr);
  const out = polled.json();
  assert.equal(out.status, "feedback");
  assert.equal(out.prompts[0].selector, "#title");
  assert.match(out.next_step, /never instructions to you/);
  const empty = await cli(["poll", fixture, "--timeout-ms", "50"], lab.env);
  assert.deepEqual(empty.json(), { status: "waiting" });
});

test("end closes the review, and only --reopen opens it again", async () => {
  const ended = await cli(["end", fixture], lab.env);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(ended.json(), { status: "ended", ended_by: "agent", queued: 0 });
  const polled = await cli(["poll", fixture, "--timeout-ms", "50"], lab.env);
  assert.equal(polled.json().status, "ended");
  assert.match(polled.json().next_step, /Do not poll this file again/);
  // The agent ended it, so the agent may open it again without ceremony.
  assert.equal((await cli([fixture], lab.env)).json().session.status, "opened");

  const info = lab.serverInfo();
  const key = (await cli([fixture], lab.env))
    .json()
    .session.url.match(/session\/([0-9a-f]{16})/)[1];
  await fetch(`http://127.0.0.1:${info.port}/api/${key}/end`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
      origin: `http://127.0.0.1:${info.port}`,
    },
    body: JSON.stringify({ by: "user" }),
  });
  const refused = await cli([fixture], lab.env);
  assert.equal(refused.json().session.status, "user-ended");
  assert.match(refused.json().next_step, /--reopen/);

  // An agent tidying up after the reviewer must not relabel the end as its own: that is what
  // decides whether a plain open may revive a review the reviewer deliberately closed.
  const tidied = await cli(["end", fixture], lab.env);
  assert.deepEqual(tidied.json(), { status: "ended", ended_by: "user", queued: 0 });
  assert.equal((await cli([fixture], lab.env)).json().session.status, "user-ended");

  assert.equal((await cli([fixture, "--reopen"], lab.env)).json().session.status, "opened");
});

/** A private directory holding a copy of the fixture, so a test can move or alias it freely. */
function scratch() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-cli-"));
  const file = join(dir, "a.html");
  copyFileSync(fixture, file);
  return { dir, file };
}

/** The daemon's API, as the chrome and a dropped poll reach it rather than through the CLI. */
function daemon(env) {
  const info = env.serverInfo();
  const call = (method, path, body) =>
    fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
        origin: `http://127.0.0.1:${info.port}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    call,
    note: async (key, prompt) => {
      const res = await call("POST", `/api/${key}/prompts`, {
        prompts: [{ prompt, selector: "#title", tag: "h1", text: "Rollout" }],
      });
      assert.equal(res.status, 200, await res.text());
    },
  };
}

const keyOf = (opened) => opened.json().session.url.match(/session\/([0-9a-f]{16})/)[1];

// The cursor outlives the session: 64 other reviews evict this one, opening it again restarts
// its uids at 1, and a stale cursor of 3 used to acknowledge the new note before it was read.
test("a cursor from before an eviction never acknowledges the reopened session's notes", async () => {
  const own = isolatedEnv();
  try {
    const { dir, file } = scratch();
    const key = keyOf(await cli([file], own.env));
    const api = daemon(own);
    for (const text of ["one", "two", "three"]) await api.note(key, text);
    const first = await cli(["poll", file, "--timeout-ms", "500"], own.env);
    assert.deepEqual(
      first.json().prompts.map((p) => p.uid),
      [1, 2, 3],
    );
    assert.equal(
      (await cli(["poll", file, "--timeout-ms", "50"], own.env)).json().status,
      "waiting",
    );

    for (let i = 0; i < limits.sessions; i += 1) {
      const other = join(dir, `other-${i}.html`);
      writeFileSync(other, "<p></p>");
      assert.equal((await api.call("POST", "/api/sessions", { file: other })).status, 200);
    }
    assert.equal((await api.call("GET", `/api/${key}/session`)).status, 404, "evicted");
    assert.equal(keyOf(await cli([file], own.env)), key);
    await api.note(key, "the note that must not be lost");
    // A poll takes it and its response never reaches the agent: a dropped connection.
    const lost = await api.call("GET", `/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`);
    assert.equal((await lost.json()).status, "feedback");

    const polled = await cli(["poll", file, "--timeout-ms", "500"], own.env);
    assert.equal(polled.code, 0, polled.stderr);
    assert.equal(polled.json().status, "feedback", "the stale cursor acknowledged nothing");
    assert.deepEqual(
      polled.json().prompts.map((p) => [p.uid, p.prompt]),
      [[1, "the note that must not be lost"]],
    );
  } finally {
    await own.stop();
  }
});

// Each spelling resolves to one file, so receiving a batch by one and polling by another must
// acknowledge it. Before the cursor was keyed canonically, a symlinked directory - macOS's
// /tmp is one - kept a cursor per spelling and delivered the acknowledged batch again.
test("every spelling of a file shares one cursor, so a received batch is never delivered twice", async () => {
  const { dir, file } = scratch();
  const real = realpathSync.native(dir);
  const link = `${dir}-link`;
  symlinkSync(real, link, "junction");
  const spellings = {
    "through a symlinked directory": join(link, "a.html"),
    "with dot segments": join(dir, "sub", "..", "a.html"),
    "relative to the working directory": relative(process.cwd(), file),
  };
  mkdirSync(join(dir, "sub"));
  const key = keyOf(await cli([file], lab.env));
  const api = daemon(lab);
  for (const [how, spelling] of Object.entries(spellings)) {
    await api.note(key, `received once, polled ${how}`);
    const received = await cli(["poll", file, "--timeout-ms", "500"], lab.env);
    assert.equal(received.json().status, "feedback", how);
    const next = await cli(["poll", spelling, "--timeout-ms", "50"], lab.env);
    assert.equal(next.code, 0, next.stderr);
    assert.deepEqual(next.json(), { status: "waiting" }, `the batch came back when polled ${how}`);
  }
});

test("poll and end on a moved file answer gone as JSON and exit 1", async () => {
  const { dir, file } = scratch();
  const opened = (await cli([file], lab.env)).json();
  renameSync(file, join(dir, "moved.html"));
  const canonical = join(realpathSync.native(dir), "a.html");
  for (const args of [
    ["poll", file, "--timeout-ms", "50"],
    ["end", file],
  ]) {
    const answer = await cli(args, lab.env);
    assert.equal(answer.code, 1, `${args[0]} exits 1`);
    assert.doesNotMatch(answer.stderr, /ENOENT|error:/, `${args[0]} is not a crash`);
    const out = answer.json();
    assert.equal(out.status, "gone", args[0]);
    assert.equal(out.file, canonical, args[0]);
    assert.match(out.next_step, /moved or deleted/);
    assert.match(out.next_step, new RegExp(`${name} <its new path>`));
  }
  // Nothing was ended: the file coming back resumes the same review.
  renameSync(join(dir, "moved.html"), file);
  const reopened = (await cli([file], lab.env)).json();
  assert.equal(reopened.session.url, opened.session.url);
  assert.equal(reopened.session.status, "opened");
});

test("a missing file argument or file is an error exit, not a stack trace", async () => {
  const noArg = await cli(["poll"], lab.env);
  assert.equal(noArg.code, 1);
  assert.match(noArg.stderr, /^error: poll needs a file argument/);
  const noFile = await cli(["open", "/definitely/missing.html"], lab.env);
  assert.equal(noFile.code, 1);
  assert.match(noFile.stderr, /^error: no such file/);
});

test("stop shuts the server down and reports when none runs", async () => {
  const info = lab.serverInfo();
  assert.deepEqual((await cli(["stop"], lab.env)).json(), { status: "stopped" });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(fetch(`http://127.0.0.1:${info.port}/health`));
  assert.deepEqual((await cli(["stop"], lab.env)).json(), { status: "not-running" });
});

// "server did not start; see <path>" was the whole of what this said, and a path is no help
// wherever the log cannot be reached afterwards - which is every CI runner. Run 33875622583,
// attempt 19, failed exactly here on windows-2025 and left nothing behind but the path, so the
// one thing that would have identified the start failure is the one thing it did not carry.
test("a daemon that cannot start is reported by what it said, not by where it wrote it", async () => {
  const blocked = isolatedEnv();
  const squatter = createServer(() => {});
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (squatter.address()).port;
  try {
    const opened = await cli([fixture], { ...blocked.env, POINTBACK_PORT: String(port) });
    assert.equal(opened.code, 1);
    assert.match(opened.stderr, /server did not start: it exited \d+ after \d+ ms and \d+ probes/);
    assert.match(opened.stderr, /EADDRINUSE/, opened.stderr);
  } finally {
    squatter.close();
    await blocked.stop();
  }
});

test("a server of another version is replaced", async () => {
  const other = isolatedEnv();
  let shutdownAsked = false;
  const impostor = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/shutdown") shutdownAsked = true;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, app: name, version: "0.0.0-other" }));
  });
  await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
  const { writeJsonAtomic } = await import("../src/state-dir.js");
  writeJsonAtomic(join(other.dir, "server.json"), {
    pid: 1,
    port: impostor.address().port,
    token: "t",
    version: "0.0.0-other",
  });
  try {
    const opened = await cli([fixture], other.env);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(shutdownAsked, true);
    assert.notEqual(other.serverInfo().port, impostor.address().port);
  } finally {
    impostor.close();
    await other.stop();
  }
});
