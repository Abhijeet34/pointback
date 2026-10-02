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
import { cli, fixture, isolatedEnv, sendNote } from "./helpers/env.js";
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
  const res = await sendNote(info, key, {
    prompt: "Shorter",
    selector: "#title",
    tag: "h1",
    text: "Rollout",
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
      const res = await sendNote(info, key, {
        prompt,
        selector: "#title",
        tag: "h1",
        text: "Rollout",
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

test("--root resolves relative to where the agent is, and is refused where it means nothing", async () => {
  const repo = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-cli-root-"));
  mkdirSync(join(repo, "sheets"));
  const sheet = join(repo, "sheets", "a.html");
  writeFileSync(sheet, "<p>a</p>");
  const opened = await cli([sheet, "--root", relative(process.cwd(), repo)], lab.env);
  assert.equal(opened.code, 0, opened.stderr);
  const { session } = opened.json();
  const info = lab.serverInfo();
  const bootstrap = await fetch(session.url.replace(/\/session\/([^#]+)#.*$/, "/api/$1/session"), {
    headers: { authorization: `Bearer ${info.token}` },
  }).then((r) => r.json());
  assert.match(bootstrap.artifactUrl, /\/sheets\/a\.html$/, "the page sits below the root");

  const outside = await cli([sheet, "--root", join(repo, "sheets", "a.html")], lab.env);
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /^error: root is not a directory/);
  const poll = await cli(["poll", sheet, "--root", repo], lab.env);
  assert.equal(poll.code, 1);
  assert.match(poll.stderr, /^error: --root applies only when opening a review/);
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

/** A token in the shape the daemon mints, recorded for a test to watch where it travels. */
const RECORDED_TOKEN = "ab".repeat(24);

async function recordServer(dir, port) {
  const { writeJsonAtomic } = await import("../src/state-dir.js");
  writeJsonAtomic(join(dir, "server.json"), {
    pid: 1,
    port,
    token: RECORDED_TOKEN,
    version: "0.0.0-other",
  });
}

// An older daemon cannot prove it holds the token, so stopping it shows the token to something that
// proved nothing. It is stopped all the same, so two daemons never share one state.json, and the
// token is retired: when it gives the port back, the new daemon takes the port and a fresh token.
for (const [how, args] of [
  ["opening a file", [fixture]],
  ["stop", ["stop"]],
]) {
  test(`a server of another version is replaced by ${how}, and the token it was shown is retired`, async () => {
    const other = isolatedEnv();
    let shutdownAsked = false;
    const impostor = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/shutdown") {
        shutdownAsked = true;
        res.end(JSON.stringify({ status: "stopping" }));
        impostor.close();
        impostor.closeAllConnections();
        return;
      }
      res.end(JSON.stringify({ ok: true, app: name, version: "0.0.0-other" }));
    });
    await new Promise((r) => impostor.listen(0, "127.0.0.1", r));
    const port = impostor.address().port;
    await recordServer(other.dir, port);
    try {
      const ran = await cli(args, other.env);
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal(shutdownAsked, true);
      if (args[0] === "stop") assert.deepEqual(ran.json(), { status: "stopped" });
      const opened = await cli([fixture], other.env);
      assert.equal(opened.code, 0, opened.stderr);
      assert.equal(other.serverInfo().port, port, "the port it gave back is taken up again");
      assert.notEqual(
        other.serverInfo().token,
        RECORDED_TOKEN,
        "the token it saw is worth nothing",
      );
    } finally {
      impostor.close();
      await other.stop();
    }
  });
}

// The port a daemon left behind can be taken by anything, and the token outlives the daemon, so
// it is presented only to a server that answers a fresh challenge keyed by it.
test("a listener on the recorded port that cannot prove it holds the token is never sent it", async () => {
  const other = isolatedEnv();
  const seen = [];
  const squatter = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, app: "something-else", proof: "0".repeat(64) }));
  });
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const port = squatter.address().port;
  await recordServer(other.dir, port);
  try {
    assert.deepEqual((await cli(["stop"], other.env)).json(), { status: "not-running" });
    const opened = await cli([fixture], other.env);
    assert.equal(opened.code, 0, opened.stderr);
    const info = other.serverInfo();
    assert.notEqual(info.port, port);
    assert.notEqual(info.token, RECORDED_TOKEN);
    assert.ok(seen.length >= 2, `the squatter was asked who it is: ${seen.join("; ")}`);
    for (const request of seen) {
      assert.match(request, /^GET \/health\?challenge=[0-9a-f]{32} -$/, "and shown nothing else");
    }
  } finally {
    squatter.close();
    await other.stop();
  }
});

test("a stopped daemon comes back on the address and token an open tab already holds", async () => {
  const own = isolatedEnv();
  try {
    const url = (await cli([fixture], own.env)).json().session.url;
    const before = own.serverInfo();
    assert.deepEqual((await cli(["stop"], own.env)).json(), { status: "stopped" });
    const polled = await cli(["poll", fixture, "--timeout-ms", "50"], own.env);
    assert.equal(polled.code, 0, polled.stderr);
    const after = own.serverInfo();
    assert.notEqual(after.pid, before.pid, "a new daemon answered the poll");
    assert.deepEqual([after.port, after.token], [before.port, before.token]);
    assert.equal((await cli([fixture], own.env)).json().session.url, url, "the same link works");
  } finally {
    await own.stop();
  }
});

// The loop closes on the agent's side: every note can be answered done, declined or with a
// question, the answer is what the reviewer's tab is sent, and a uid the review never issued is
// refused rather than stored against nothing.
test("reply answers a note done, declined or with a question, and refuses a uid it never issued", async () => {
  const { file } = scratch();
  const key = keyOf(await cli([file], lab.env));
  const api = daemon(lab);
  for (const text of ["one", "two", "three"]) await api.note(key, text);
  const polled = (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json();
  assert.deepEqual(
    polled.prompts.map((p) => p.uid),
    [1, 2, 3],
  );
  assert.equal(
    polled.reply_with,
    `${name} reply ${file} <uid> --done | --declined | --question, with --message "..." for a reason or a question; the reviewer reads it on that note.`,
    "every batch reminds the agent how to answer, so the loop does not rest on a skill file",
  );
  assert.match(polled.next_step, /Apply them, reply to each, then run/);

  const replies = [
    [["1", "--done"], { status: "done" }],
    [
      ["2", "--declined", "--message", "The title is the product name"],
      { status: "declined", message: "The title is the product name" },
    ],
    [
      ["3", "--question", "--message", "Which queue: billing or email?"],
      { status: "question", message: "Which queue: billing or email?" },
    ],
  ];
  for (const [args, expected] of replies) {
    const replied = await cli(["reply", file, ...args], lab.env);
    assert.equal(replied.code, 0, replied.stderr);
    const out = replied.json();
    assert.equal(out.status, "replied");
    assert.equal(out.uid, Number(args[0]));
    const { at, ...reply } = out.reply;
    assert.deepEqual(reply, expected);
    assert.ok(Number.isFinite(Date.parse(at)), "the reply is stamped");
  }
  // Stored on the note itself, where the reviewer's tab reads it on every connect.
  const chat = (await (await api.call("GET", `/api/${key}/session`)).json()).chat;
  assert.deepEqual(
    chat.map((entry) => [entry.uid, entry.reply.status, entry.reply.message]),
    [
      [1, "done", undefined],
      [2, "declined", "The title is the product name"],
      [3, "question", "Which queue: billing or email?"],
    ],
  );
  // A later reply replaces an earlier one: the question, once answered, can become done.
  assert.equal((await cli(["reply", file, "3", "--done"], lab.env)).json().reply.status, "done");

  const refused = async (args, pattern) => {
    const result = await cli(["reply", file, ...args], lab.env);
    assert.equal(result.code, 1, `${args.join(" ")} exits 1`);
    assert.equal(result.stdout, "", `${args.join(" ")} prints no answer`);
    assert.match(result.stderr, pattern, args.join(" "));
  };
  await refused(["9", "--done"], /^error: no note 9 in this review$/m);
  await refused(["0", "--done"], /the note's uid/);
  await refused(["two", "--done"], /the note's uid/);
  await refused(["--done"], /the note's uid/);
  await refused(["1"], /exactly one of --done, --declined, --question/);
  await refused(["1", "--done", "--declined"], /exactly one of/);
  await refused(["1", "--question"], /a question needs its text/);
  await refused(
    ["1", "--declined", "--message", "x".repeat(limits.replyChars + 1)],
    /over 2000 characters/,
  );
  const never = join(scratch().dir, "a.html");
  const unopened = await cli(["reply", never, "1", "--done"], lab.env);
  assert.equal(unopened.code, 1);
  assert.match(unopened.stderr, /no such session/);
});

test("a note that answers the agent's question names its uid, and only a uid the review issued", async () => {
  const { file } = scratch();
  const key = keyOf(await cli([file], lab.env));
  const api = daemon(lab);
  await api.note(key, "Shorter");
  const [asked] = (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json().prompts;
  await cli(["reply", file, String(asked.uid), "--question", "--message", "How short?"], lab.env);

  const answer = { prompt: "Three words", selector: "#title", tag: "h1", text: "Rollout" };
  const stray = await api.call("POST", `/api/${key}/drafts`, { draft: { ...answer, answers: 42 } });
  assert.equal(stray.status, 400);
  assert.match((await stray.json()).error, /names no note in this review: 42/);
  const res = await sendNote(lab.serverInfo(), key, { ...answer, answers: asked.uid });
  assert.equal(res.status, 200, await res.text());
  const delivered = (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json();
  assert.deepEqual(
    delivered.prompts.map(({ prompt, answers }) => ({ prompt, answers })),
    [{ prompt: "Three words", answers: asked.uid }],
  );
  assert.match(delivered.next_step, /`answers` is the reviewer's answer to the question you asked/);
});
