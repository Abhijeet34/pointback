import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { name, version } from "../src/identity.js";
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
