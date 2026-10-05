import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { cli, fixture, isolatedEnv, presenceOf, sendNote } from "./helpers/env.js";
import { assertPrivate } from "./helpers/private.js";
import { until } from "./helpers/wait.js";

const lab = isolatedEnv();
after(() => lab.stop());

test("--version and --help answer without touching the state directory", async () => {
  assert.equal((await cli(["--version"], lab.env)).stdout.trim(), version);
  const help = await cli(["--help"], lab.env);
  assert.match(help.stdout, new RegExp(`^${name} ${version}`));
  assert.equal((await cli([], lab.env)).stdout, help.stdout);
});

// The help is the CLI's own contract: one column for every description, every environment
// variable the code reads, and both kinds of file a review opens.
test("--help aligns its descriptions and names every variable and file kind", async () => {
  const help = (await cli(["--help"], lab.env)).stdout;
  const usage = help.slice(help.indexOf("Usage:"), help.indexOf("Output is JSON"));
  const commands = usage.split("\n").filter((line) => line.startsWith(`  ${name}`));
  const described = usage.split("\n").filter((line) => /^ {3,}\S/.test(line));
  assert.equal(commands.length, 6);
  assert.deepEqual(new Set(described.map((line) => line.search(/\S/))).size, 1, usage);
  assert.match(usage, /\.md\b/);
  const read = new Set();
  for (const file of readdirSync(new URL("../src", import.meta.url)).filter((f) =>
    f.endsWith(".js"),
  ))
    for (const [, key] of readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").matchAll(
      /\benv\("([A-Z_]+)"/g,
    ))
      read.add(key);
  assert.ok(read.has("IDLE_MS"), [...read].join(", "));
  const environment = help.slice(help.indexOf("Environment:"));
  const prefix = `${name.toUpperCase()}_`;
  const listed = [...environment.matchAll(new RegExp(`^  ${prefix}([A-Z_]+) +\\S`, "gm"))];
  assert.deepEqual(listed.map(([, key]) => key).sort(), [...read].sort());
  assert.equal(new Set(listed.map((m) => m[0].length)).size, 1, "one column for what each means");
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
  // Each session's file is under `sessions/`, so the walk goes down into it.
  for (const entry of readdirSync(lab.dir, { recursive: true, withFileTypes: true }))
    assertPrivate(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
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
  await until(async () => (await presenceOf(info, key)) === "listening", {
    what: "the poll to attach",
  });
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
    note: async (key, prompt, structure) => {
      const res = await sendNote(
        info,
        key,
        { prompt, selector: "#title", tag: "h1", text: "Rollout" },
        structure,
      );
      assert.equal(res.status, 200, await res.text());
    },
  };
}

const keyOf = (opened) => opened.json().session.url.match(/session\/([0-9a-f]{16})/)[1];

// The cursor outlives the session: 64 other reviews evict this one, opening it again restarts
// its uids at 1, and a stale cursor of 3 used to acknowledge the new note before it was read.
// SKILL.md tells the agent to skip any uid it has already applied, so a uid must never come round
// again for the same file: before, a reopened session restarted at 1 and the agent dropped it.
test("after an eviction a new note takes a uid the agent never saw, and an old cursor acknowledges nothing", async () => {
  const own = isolatedEnv();
  try {
    const { dir, file } = scratch();
    const key = keyOf(await cli([file], own.env));
    const api = daemon(own);
    for (const text of ["one", "two", "three"]) await api.note(key, text);
    const first = await cli(["poll", file, "--timeout-ms", "500"], own.env);
    const applied = new Set(first.json().prompts.map((p) => p.uid));
    assert.deepEqual([...applied], [1, 2, 3]);
    assert.equal(
      (await cli(["poll", file, "--timeout-ms", "50"], own.env)).json().status,
      "waiting",
    );
    // A session is held from eviction for the grace after its last poll.
    await until(async () => (await presenceOf(own.serverInfo(), key)) === "waiting", {
      what: "the poll's grace to pass",
    });

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
      [[4, "the note that must not be lost"]],
    );
    assert.deepEqual(
      polled
        .json()
        .prompts.filter((p) => !applied.has(p.uid))
        .map((p) => p.prompt),
      ["the note that must not be lost"],
      "an agent skipping the uids it already applied, as SKILL.md says, applies the new note",
    );
  } finally {
    await own.stop();
  }
});

// Evicted under two open tabs on 0.1.6, the tabs heard nothing, the agent's reopen said a tab was
// open while that tab's page answered 404, and closing the newer tab read the gone session in the
// socket's close handler and took the daemon down with every other review.
test("a review with tabs open is never evicted, closing one leaves the daemon up, and after a real eviction a reopen opens a tab", async () => {
  const own = isolatedEnv();
  try {
    const { dir, file } = scratch();
    const key = keyOf(await cli([file], own.env));
    const api = daemon(own);
    const older = await tab(own, key);
    const newer = await tab(own, key);
    assert.equal((await older.until("superseded"))?.type, "superseded");
    for (let i = 0; i < limits.sessions; i += 1) {
      const other = join(dir, `other-${i}.html`);
      writeFileSync(other, "<p></p>");
      assert.equal((await api.call("POST", "/api/sessions", { file: other })).status, 200);
    }
    newer.close();
    const promoted = await older.until("current");
    assert.equal((await api.call("GET", "/health")).status, 200, "the daemon outlived the tab");
    assert.equal(promoted?.type, "current", "the older tab took the review back");
    assert.equal((await api.call("GET", `/api/${key}/session`)).status, 200, "the review was kept");

    // With no tab on it the review is fair game again; it goes at the first open once the server
    // has let its last tab go, since it is the longest untouched.
    older.close();
    let more = 0;
    await until(
      async () => {
        const other = join(dir, `more-${(more += 1)}.html`);
        writeFileSync(other, "<p></p>");
        assert.equal((await api.call("POST", "/api/sessions", { file: other })).status, 200);
        return (await api.call("GET", `/api/${key}/session`)).status === 404;
      },
      { what: "the review to be evicted once its tabs closed" },
    );
    const reopened = await cli([file], own.env);
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.doesNotMatch(reopened.json().next_step, /already open/, "a fresh tab is opened");
    const page = await fetch(reopened.json().session.url.split("#")[0]);
    assert.equal(page.status, 200, "and its page loads");
  } finally {
    await own.stop();
  }
});

test("when every review held has a tab open, a new open is refused with the reason and the way out", async () => {
  const own = isolatedEnv();
  const tabs = [];
  try {
    const { dir, file } = scratch();
    const keys = [keyOf(await cli([file], own.env))];
    tabs.push(await tab(own, keys[0]));
    const api = daemon(own);
    for (let i = 1; i < limits.sessions; i += 1) {
      const other = join(dir, `other-${i}.html`);
      writeFileSync(other, "<p></p>");
      const { key } = await (await api.call("POST", "/api/sessions", { file: other })).json();
      keys.push(key);
      tabs.push(await tab(own, key));
    }
    const oneMore = join(dir, "one-more.html");
    writeFileSync(oneMore, "<p></p>");
    const refused = await cli([oneMore], own.env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(
      refused.stderr,
      /open in a tab, being polled or holding notes.*ask the reviewer to close the tab of a finished review, let a poll on a review run to the end or end that review, or for a review holding notes, poll it until a poll comes back with no new notes, or ask the reviewer to discard unsent notes, or to send them and then poll it that way \(a review held for more than one of these needs each cleared\)/,
    );
    const statuses = [];
    for (const key of keys) statuses.push((await api.call("GET", `/api/${key}/session`)).status);
    assert.deepEqual(statuses, Array(limits.sessions).fill(200), "every held review still answers");
  } finally {
    for (const open of tabs) open.close();
    await own.stop();
  }
});

/** A review tab's event stream, held the way the chrome holds it. */
async function tab(env, key) {
  const { port, token } = env.serverInfo();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/${key}/events`, [
    "events",
    `bearer.${token}`,
  ]);
  const events = [];
  socket.addEventListener("message", (message) => events.push(JSON.parse(message.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`no stream for ${key}`)));
  });
  const find = (type) => events.find((event) => event.type === type);
  return {
    close: () => socket.close(),
    /** The first event of `type`, or null if the stream closed without one. */
    async until(type) {
      await until(() => find(type) || socket.readyState === WebSocket.CLOSED, {
        what: `a ${type} event on ${key}`,
      });
      return find(type) ?? null;
    },
  };
}

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

test("poll, reply and end on a moved file answer gone as JSON and exit 1", async () => {
  const { dir, file } = scratch();
  const openedRun = await cli([file], lab.env);
  const opened = openedRun.json();
  const key = keyOf(openedRun);
  const api = daemon(lab);
  await api.note(key, "taken before the move");
  assert.equal(
    (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json().status,
    "feedback",
  );
  renameSync(file, join(dir, "moved.html"));
  const canonical = join(realpathSync.native(dir), "a.html");
  for (const args of [
    ["poll", file, "--timeout-ms", "50"],
    ["reply", file, "1", "--done"],
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
  // Nothing was ended or answered: the file coming back resumes the same review.
  renameSync(join(dir, "moved.html"), file);
  const reopened = (await cli([file], lab.env)).json();
  assert.equal(reopened.session.url, opened.session.url);
  assert.equal(reopened.session.status, "opened");
  const chat = (await (await api.call("GET", `/api/${key}/session`)).json()).chat;
  assert.deepEqual(
    chat.map((entry) => [entry.uid, entry.reply]),
    [[1, undefined]],
    "the reply to a gone file was not stored",
  );
});

test("a missing file argument or file is an error exit, not a stack trace", async () => {
  const noArg = await cli(["poll"], lab.env);
  assert.equal(noArg.code, 1);
  assert.match(noArg.stderr, /^error: poll needs a file argument/);
  const missing = join(scratch().dir, "missing.html");
  for (const args of [
    ["open", missing],
    ["poll", missing, "--timeout-ms", "0"],
    ["reply", missing, "1", "--done"],
    ["end", missing],
  ]) {
    const noFile = await cli(args, lab.env);
    assert.equal(noFile.code, 1, args[0]);
    assert.equal(noFile.stdout, "", args[0]);
    assert.match(noFile.stderr, /^error: no such file: \S*missing\.html\n$/, args[0]);
  }
});

test("a file that is neither HTML nor Markdown is refused with a message and exit 1", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-kind-"));
  writeFileSync(join(dir, "notes.txt"), "plain notes\n");
  const refused = await cli([join(dir, "notes.txt")], lab.env);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(
    refused.stderr,
    "error: notes.txt cannot be reviewed: open an HTML (.html, .htm) or Markdown (.md, .markdown) file\n",
  );
  writeFileSync(join(dir, "notes.md"), "# Notes\n");
  const opened = await cli([join(dir, "notes.md")], lab.env);
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(opened.json().session.status, "opened");
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
  await until(
    () =>
      fetch(`http://127.0.0.1:${info.port}/health`).then(
        () => false,
        () => true,
      ),
    { what: "the stopped server to stop answering" },
  );
  assert.deepEqual((await cli(["stop"], lab.env)).json(), { status: "not-running" });
});

/** `count` copies of the fixture under a fresh folder, so concurrent opens each review their own file. */
function copies(count) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-copies-"));
  return Array.from({ length: count }, (_, i) => {
    const file = join(dir, `f${i}.html`);
    copyFileSync(fixture, file);
    return file;
  });
}

// An agent's parallel tool calls are the usual way two commands meet a state directory with no
// daemon on it. Each start spawns one; on 0.1.6 every one of them bound a port and loaded the
// sessions, and every CLI but the last to write server.json gave up after 10 s.
test("eight opens at once on a cold state directory all succeed, against one daemon", async () => {
  const cold = isolatedEnv();
  try {
    const files = copies(8);
    const started = Date.now();
    const opened = await Promise.all(files.map((file) => cli([file], cold.env)));
    console.log(`eight concurrent opens returned in ${Date.now() - started} ms`);
    assert.deepEqual(
      opened.map((o) => o.code),
      Array(8).fill(0),
      opened.map((o) => o.stderr).join(""),
    );
    const ports = new Set(opened.map((o) => new URL(o.json().session.url).port));
    assert.deepEqual([...ports], [String(cold.serverInfo().port)], "every review on one daemon");
    const info = cold.serverInfo();
    const lockFiles = readdirSync(cold.dir).filter((file) => /^daemon\.\d+\.lock$/.test(file));
    assert.equal(lockFiles.length, 1, `one claim holds the directory: ${lockFiles.join(", ")}`);
    assert.equal(
      JSON.parse(readFileSync(join(cold.dir, lockFiles[0]), "utf8")).pid,
      info.pid,
      "the claim names the daemon the record names",
    );
    const health = await fetch(`http://127.0.0.1:${info.port}/health`).then((res) => res.json());
    assert.equal(health.pid, info.pid, "the one port answers as the one daemon");
    assert.doesNotThrow(() => process.kill(info.pid, 0), "that daemon is alive");
  } finally {
    await cold.stop();
  }
});

// The review's split-brain reproduction. After an idle-out, concurrent starts raced for the old
// port: a tab reconnected to the daemon that won it while server.json, and so the agent, named
// another, and the agent's next open wrote that other daemon's stale copy over the sent note.
test("a note sent from a tab that outlived its daemon reaches the agent after concurrent restarts", async () => {
  const split = isolatedEnv();
  try {
    const [reviewed, ...others] = copies(8);
    const url = new URL((await cli([reviewed], split.env)).json().session.url);
    const tab = { port: Number(url.port), token: url.hash.slice(1) };
    const key = url.pathname.split("/").pop();
    assert.deepEqual((await cli(["stop"], split.env)).json(), { status: "stopped" });
    await until(
      () =>
        fetch(`http://127.0.0.1:${tab.port}/health`).then(
          () => false,
          () => true,
        ),
      { what: "the stopped daemon to stop answering" },
    );
    const reopened = await Promise.all(others.map((file) => cli([file], split.env)));
    assert.deepEqual(
      reopened.map((o) => o.code),
      Array(others.length).fill(0),
      reopened.map((o) => o.stderr).join(""),
    );

    // The tab reconnects on its own port with the token in its fragment, as it does on its own.
    const note = { selector: "#title", tag: "h1", text: "Rollout" };
    const sent = await sendNote(tab, key, { ...note, prompt: "the note that must not be lost" });
    assert.equal(sent.status, 200);
    assert.equal((await cli([reviewed], split.env)).code, 0, "the agent opens the file again");
    const polled = (await cli(["poll", reviewed, "--timeout-ms", "0"], split.env)).json();
    assert.equal(polled.status, "feedback", JSON.stringify(polled));
    assert.deepEqual(
      polled.prompts.map((p) => p.prompt),
      ["the note that must not be lost"],
    );
  } finally {
    await split.stop();
  }
});

// The interleaving behind the concurrent-restart failures in hunt 37251439894 (attempts 2, 8, 19):
// an open's first look at the stopped daemon's record finds nothing, a sibling open's daemon then
// publishes its own record, and the open's second look took that live daemon of this very version
// for an older one that "did not stop". The stopped daemon's port here publishes the sibling's
// record at the moment it is probed, so the open meets exactly that order every time.
test("an open whose first look misses a sibling's daemon starting uses that daemon, never refuses it as older", async () => {
  const racing = isolatedEnv();
  let sibling;
  let probes = 0;
  const stopped = createServer((req) => {
    probes += 1;
    if (probes === 1) writeFileSync(join(racing.dir, "server.json"), JSON.stringify(sibling));
    req.socket.destroy();
  });
  try {
    assert.equal((await cli([fixture], racing.env)).code, 0);
    sibling = racing.serverInfo();
    await new Promise((r) => stopped.listen(0, "127.0.0.1", r));
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(
      join(racing.dir, "server.json"),
      JSON.stringify({ ...sibling, pid: exited, port: stopped.address().port }),
    );

    const opened = await cli([copies(1)[0]], racing.env);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(probes, 1, "the stopped daemon's port was looked at once");
    assert.equal(new URL(opened.json().session.url).port, String(sibling.port), "on the sibling");
    assert.equal(racing.serverInfo().pid, sibling.pid, "and no second daemon took the record");
  } finally {
    stopped.close();
    await racing.stop();
  }
});

// A start that finds a daemon still holding the directory exits 0 and leaves it to that daemon;
// when that daemon was on its way out and never answers, the CLI has to start another itself.
test("an open that meets a daemon on its way out starts the next one", async () => {
  const leaving = isolatedEnv();
  const holder = createServer(() => {});
  await new Promise((r) => holder.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (holder.address()).port;
  writeFileSync(join(leaving.dir, "daemon.1.lock"), JSON.stringify({ pid: process.pid, port }));
  try {
    const opening = cli([copies(1)[0]], leaving.env);
    await until(
      () => {
        try {
          return readFileSync(join(leaving.dir, "server.log"), "utf8").includes("already serves");
        } catch {
          return false;
        }
      },
      { what: "a start to find the holder and step aside" },
    );
    holder.close();
    const opened = await opening;
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(new URL(opened.json().session.url).port, String(leaving.serverInfo().port));
  } finally {
    holder.close();
    await leaving.stop();
  }
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
    pid: process.pid,
    port,
    token: RECORDED_TOKEN,
    version: "0.0.0-other",
  });
}

// An older daemon cannot prove it holds the token, so stopping it shows the token to something that
// proved nothing. It is stopped all the same, so two daemons never share one set of sessions, and the
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

// An older daemon that refuses to stop still holds the port and the sessions. Starting another beside it
// would split the directory between two daemons, so each open refuses until that daemon is gone. It has
// been shown the token without proving it holds it, so the token is retired at once, whether or not it
// stopped, and is never shown again: when the port comes back, the next daemon takes a fresh token.
test("an older daemon that refuses to stop blocks every open, sees the token once, and the token is retired", async () => {
  const other = isolatedEnv();
  const shown = [];
  const refuser = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/shutdown") {
      shown.push(req.headers.authorization);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, app: name, version: "0.0.0-other" }));
  });
  await new Promise((r) => refuser.listen(0, "127.0.0.1", r));
  const port = refuser.address().port;
  await recordServer(other.dir, port);
  try {
    for (const attempt of [1, 2]) {
      const opened = await cli([fixture], other.env);
      assert.equal(opened.code, 1, `attempt ${attempt}: ${opened.stdout}`);
      assert.ok(
        opened.stderr.includes(
          `error: an older ${name} daemon (pid ${process.pid}) on port ${port} did not stop; end that process and retry`,
        ),
        opened.stderr,
      );
      assert.equal(
        other.serverInfo().token,
        null,
        `attempt ${attempt}: the token it saw is retired`,
      );
    }
    assert.deepEqual(
      (await cli(["stop"], other.env)).json(),
      { status: "refused", pid: process.pid, port },
      "stop names the server it could not stop, by pid and port",
    );
    assert.deepEqual(shown, [`Bearer ${RECORDED_TOKEN}`], "the token reached it once, never again");
    assert.equal(
      existsSync(join(other.dir, "daemon.1.lock")),
      false,
      "no daemon claimed the directory",
    );

    refuser.close();
    refuser.closeAllConnections();
    const opened = await cli([fixture], other.env);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(other.serverInfo().port, port, "the port it gave back is taken up again");
    assert.notEqual(other.serverInfo().token, RECORDED_TOKEN, "with a token it never saw");
  } finally {
    refuser.close();
    await other.stop();
  }
});

test("a recorded server that accepts the connection but never answers blocks the open instead of a second daemon starting", async () => {
  const other = isolatedEnv();
  const stalled = createServer(() => {});
  await new Promise((r) => stalled.listen(0, "127.0.0.1", r));
  const port = stalled.address().port;
  await recordServer(other.dir, port);
  try {
    const opened = await cli([fixture], other.env);
    assert.equal(opened.code, 1, opened.stdout);
    assert.ok(
      opened.stderr.includes(
        `error: an older ${name} daemon (pid ${process.pid}) on port ${port} did not stop; end that process and retry`,
      ),
      opened.stderr,
    );
    assert.equal(existsSync(join(other.dir, "daemon.1.lock")), false, "no daemon claimed it");
  } finally {
    stalled.closeAllConnections();
    stalled.close();
    await other.stop();
  }
});

test("a record whose process has exited blocks nothing, and a live daemon on its port is neither named nor sent its token", async () => {
  const stale = isolatedEnv();
  const live = isolatedEnv();
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  try {
    assert.equal((await cli([fixture], live.env)).code, 0);
    const livePort = live.serverInfo().port;
    writeFileSync(
      join(stale.dir, "server.json"),
      JSON.stringify({
        pid: exited,
        port: livePort,
        token: RECORDED_TOKEN,
        version: "0.0.0-other",
      }),
    );
    assert.deepEqual((await cli(["stop"], stale.env)).json(), { status: "not-running" });
    const opened = await cli([fixture], stale.env);
    assert.equal(opened.code, 0, opened.stderr);
    assert.notEqual(stale.serverInfo().port, livePort, "it starts its own daemon");
  } finally {
    await stale.stop();
    await live.stop();
  }
});

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
  await refused(["1", "--question"], /^error: --question needs the question's text in --message$/m);
  await refused(["1", "--question", "--message", "  "], /in --message$/m);
  await refused(
    ["1", "--declined", "--message", "x".repeat(limits.replyChars + 1)],
    /^error: --message is over 2000 characters$/m,
  );
  const never = join(scratch().dir, "a.html");
  const unopened = await cli(["reply", never, "1", "--done"], lab.env);
  assert.equal(unopened.code, 1);
  assert.match(unopened.stderr, /no such session/);
});

test("a reply that meets a session another process rewrote is made once more and lands", async () => {
  const { file } = scratch();
  const key = keyOf(await cli([file], lab.env));
  await daemon(lab).note(key, "the note the reply answers");
  const [{ uid }] = (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json().prompts;
  const path = join(lab.dir, "sessions", `${key}.json`);
  writeFileSync(`${path}.tmp`, readFileSync(path));
  renameSync(`${path}.tmp`, path);
  const replied = await cli(["reply", file, String(uid), "--done"], lab.env);
  assert.equal(replied.code, 0, replied.stderr);
  assert.equal(replied.json().reply.status, "done");
});

test("a note that answers the agent's question names its uid, and only a uid the review issued", async () => {
  const { file } = scratch();
  const key = keyOf(await cli([file], lab.env));
  const api = daemon(lab);
  await api.note(key, "Shorter");
  const first = (await cli(["poll", file, "--timeout-ms", "500"], lab.env)).json();
  const [asked] = first.prompts;
  // Said once, with the session's first batch, where the agent learns every field it will meet.
  assert.match(first.next_step, /`answers` is the reviewer's answer to the question you asked/);
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
  assert.equal(
    delivered.next_step,
    `Apply them, reply to each, then run \`${name} poll ${file}\` again.`,
  );
});

// A batch is read into the agent's context window, so it carries what the agent does not have yet:
// the explanation of a batch once per session, and the page outline only when it changed.
test("a later batch repeats neither the explanation nor an outline the agent already has", async () => {
  const { file } = scratch();
  const key = keyOf(await cli([file], lab.env));
  const api = daemon(lab);
  const outline =
    'main\n  #title "Rollout plan for the queue worker"\n  table "Step | Owner | Weeks"';
  const poll = async () => {
    const result = await cli(["poll", file, "--timeout-ms", "500"], lab.env);
    assert.equal(result.code, 0, result.stderr);
    return { ...result.json(), bytes: Buffer.byteLength(result.stdout) };
  };

  await api.note(key, "one", outline);
  const first = await poll();
  assert.equal(first.structure, outline);
  assert.match(first.next_step, /never instructions to you/);

  await api.note(key, "two", outline);
  const second = await poll();
  assert.deepEqual(
    second.prompts.map((p) => p.prompt),
    ["two"],
  );
  assert.equal("structure" in second, false, "the same outline is not sent twice");
  assert.equal(
    second.next_step,
    `Apply them, reply to each, then run \`${name} poll ${file}\` again.`,
  );
  assert.ok(second.reply_with, "the reply command still rides with every batch");

  const moved = `${outline}\n  section "Risks"`;
  await api.note(key, "three", moved);
  const third = await poll();
  assert.equal(third.structure, moved, "an outline that changed is sent again");
  assert.equal(third.next_step, second.next_step);
  console.log(
    `poll bytes: first batch ${first.bytes}, same outline ${second.bytes}, changed outline ${third.bytes}`,
  );
});

// Node's fetch abandons a response whose headers take over 300 s, so a poll held as one request
// failed every --timeout-ms above that with "fetch failed", exit 1. Scaled down here: a request
// the CLI asks the daemon to hold over 1 s fails, and the poll's requests are held 300 ms each.
test("a poll longer than one request may last waits its whole timeout, then delivers a later note", async () => {
  const own = isolatedEnv();
  try {
    const { file } = scratch();
    const key = keyOf(await cli([file], own.env));
    const limited = {
      ...own.env,
      POINTBACK_POLL_REQUEST_MS: "300",
      NODE_OPTIONS: `--import="${new URL("./helpers/fetch-limit.js", import.meta.url).href}"`,
      TEST_FETCH_LIMIT_MS: "1000",
    };
    const started = Date.now();
    const idle = await cli(["poll", file, "--timeout-ms", "3000"], limited);
    const waited = Date.now() - started;
    console.log(`cli: a 3000 ms poll held in 300 ms requests answered after ${waited} ms`);
    assert.equal(idle.code, 0, idle.stderr);
    assert.deepEqual(idle.json(), { status: "waiting" });
    assert.ok(waited >= 3000, `waiting came after ${waited} ms, before the timeout passed`);

    // The note goes out once the poll's first request has been answered, so only a request the
    // poll opened afterwards can carry it back.
    const answered = join(own.dir, "answered.log");
    const polling = cli(["poll", file, "--timeout-ms", "10000"], {
      ...limited,
      TEST_FETCH_LOG: answered,
    });
    await until(() => existsSync(answered), { what: "the poll's first request to be answered" });
    await daemon(own).note(key, "sent late");
    const polled = await polling;
    assert.equal(polled.code, 0, polled.stderr);
    assert.deepEqual(
      polled.json().prompts.map((p) => p.prompt),
      ["sent late"],
    );
  } finally {
    await own.stop();
  }
});

test("a --timeout-ms the server refuses is refused at once with its message, as before", async () => {
  const { file } = scratch();
  assert.equal((await cli([file], lab.env)).code, 0);
  for (const value of ["Infinity", "300000.5"]) {
    const refused = await cli(["poll", file, "--timeout-ms", value], lab.env, {
      timeoutMs: 30_000,
    });
    assert.equal(refused.code, 1, value);
    assert.equal(refused.stdout, "", value);
    assert.ok(refused.stderr.endsWith("error: timeoutMs must be a non-negative integer\n"), value);
  }
});

test("a POLL_REQUEST_MS outside 1 to 240000, or not an integer, is refused before any request", async () => {
  const { file } = scratch();
  for (const value of ["0", "400000", "soon"]) {
    const refused = await cli(
      ["poll", file, "--timeout-ms", "50"],
      {
        ...lab.env,
        POINTBACK_POLL_REQUEST_MS: value,
      },
      { timeoutMs: 30_000 },
    );
    assert.equal(refused.code, 1, value);
    assert.equal(refused.stdout, "", value);
    assert.equal(
      refused.stderr,
      "error: POINTBACK_POLL_REQUEST_MS must be an integer from 1 to 240000\n",
      value,
    );
  }
});
