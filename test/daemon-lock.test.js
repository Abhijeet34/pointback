import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimDaemon, probeTimeout } from "../src/daemon-lock.js";
import { name } from "../src/identity.js";
import { closedPort, stallNextTick } from "./helpers/stall.js";

const stateDir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-lock-"));
const locks = (dir) => readdirSync(dir).filter((name) => name.endsWith(".lock"));
const record = (dir, generation, holder) =>
  writeFileSync(join(dir, `daemon.${generation}.lock`), JSON.stringify(holder));

/** A pid that belonged to a process and no longer does, as a crashed daemon's does. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

async function listening() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port };
}

/** A listener whose `/health` answers with `body`, and nothing else. */
async function answering(body) {
  const server = httpServer((req, res) => res.end(JSON.stringify(body)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port };
}

test("a live daemon keeps the state directory, and a second start is told so", async () => {
  const dir = stateDir();
  const first = await claimDaemon(dir);
  assert.ok(first);
  assert.equal(await claimDaemon(dir), null, "while it starts");
  const { server, port } = await answering({ ok: true, app: name, pid: process.pid });
  try {
    assert.equal(first.publish(port), true);
    assert.equal(await claimDaemon(dir), null, "once it listens");
  } finally {
    server.close();
  }
});

test("a crashed daemon's lock is taken over, and its generation cleared", async () => {
  const dir = stateDir();
  record(dir, 4, { pid: deadPid(), port: await closedPort() });
  assert.ok(await claimDaemon(dir));
  assert.deepEqual(locks(dir), ["daemon.5.lock"]);
});

// After a reboot a crashed daemon's pid can belong to anything; with nothing on its port it is not
// a daemon, or every start would wait on it for good.
test("a lock whose pid came back but whose port is closed is taken over", async () => {
  const dir = stateDir();
  record(dir, 1, { pid: process.pid, port: await closedPort() });
  assert.ok(await claimDaemon(dir));
});

// A start the machine descheduled for longer than the probe's 1 s timeout comes back to the port's
// refusal and an expired timer at once. The refusal is the answer, or the dead holder reads as busy.
test("a start stalled past the probe's timeout still takes over a lock whose port is closed", async () => {
  const dir = stateDir();
  record(dir, 1, { pid: process.pid, port: await closedPort() });
  stallNextTick(1_500);
  assert.ok(await claimDaemon(dir));
});

// A reboot can hand a crashed daemon's pid to a process and its sticky port to another listener; a
// listener that is not pointback is not a daemon, or the directory would be locked for good.
test("a lock whose pid came back and whose port answers as another app is taken over", async () => {
  const dir = stateDir();
  const { server, port } = await answering({ ok: true, app: "something-else" });
  try {
    record(dir, 1, { pid: process.pid, port });
    assert.ok(await claimDaemon(dir));
    assert.deepEqual(locks(dir), ["daemon.2.lock"]);
  } finally {
    server.close();
  }
});

// A pointback daemon on the recorded port serving another state directory is not this holder: the
// holder's own pid is the one its /health must report.
test("a pointback daemon of another pid on the recorded port does not hold this directory", async () => {
  const dir = stateDir();
  const { server, port } = await answering({ ok: true, app: name, pid: process.ppid });
  try {
    record(dir, 1, { pid: process.pid, port });
    assert.ok(await claimDaemon(dir));
    assert.deepEqual(locks(dir), ["daemon.2.lock"]);
  } finally {
    server.close();
  }
});

test("a pointback daemon of another pid, stalled past the probe's timeout, does not hold this directory", async () => {
  const dir = stateDir();
  const { server, port } = await answering({ ok: true, app: name, pid: process.ppid });
  try {
    record(dir, 1, { pid: process.pid, port });
    stallNextTick(1_500);
    assert.ok(await claimDaemon(dir));
    assert.deepEqual(locks(dir), ["daemon.2.lock"]);
  } finally {
    server.close();
  }
});

test("a daemon too busy to answer within a second still holds the state directory", async () => {
  const dir = stateDir();
  const { server, port } = await listening();
  try {
    record(dir, 1, { pid: process.pid, port });
    assert.equal(await claimDaemon(dir), null);
  } finally {
    server.close();
  }
});

test("a probe starved past its wall ceiling aborts there, though its running time barely accrued", async () => {
  const probe = probeTimeout(60_000, 300);
  for (let turn = 0; !probe.signal.aborted && turn < 100; turn += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  probe.done();
  assert.equal(probe.signal.reason?.name, "TimeoutError");
});

test("a start that died before it wrote its lock is waited on only for a bounded time", async () => {
  const dir = stateDir();
  writeFileSync(join(dir, "daemon.1.lock"), "");
  assert.equal(await claimDaemon(dir), null, "a fresh empty lock is a start in progress");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "daemon.1.lock"), old, old);
  assert.ok(await claimDaemon(dir));
});

// Replacing a dead holder by delete-then-create lets two starts that both saw it die each delete
// the other's fresh lock; claiming the next generation exclusively lets exactly one through.
test("starts racing to replace one dead holder: exactly one wins", async () => {
  const dir = stateDir();
  record(dir, 7, { pid: deadPid(), port: await closedPort() });
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimDaemon(dir)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.deepEqual(locks(dir), ["daemon.8.lock"]);
});

test("a stalled start that was taken over learns so when it publishes, and steps aside", async () => {
  const dir = stateDir();
  const stalled = await claimDaemon(dir);
  record(dir, 2, { pid: process.pid, port: null });
  const { server, port } = await listening();
  try {
    assert.equal(stalled.publish(port), false);
    assert.deepEqual(locks(dir), ["daemon.2.lock"]);
  } finally {
    server.close();
  }
});

test("a daemon that releases the directory lets the next start in at once", async () => {
  const dir = stateDir();
  const { server, port } = await listening();
  try {
    const first = await claimDaemon(dir);
    first.publish(port);
    first.release();
    assert.ok(await claimDaemon(dir), "even with the old port still answering");
  } finally {
    server.close();
  }
});
