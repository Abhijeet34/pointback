import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimDaemon } from "../src/daemon-lock.js";

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

async function closedPort() {
  const { server, port } = await listening();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a live daemon keeps the state directory, and a second start is told so", async () => {
  const dir = stateDir();
  const first = await claimDaemon(dir);
  assert.ok(first);
  assert.equal(await claimDaemon(dir), null, "while it starts");
  const { server, port } = await listening();
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
