import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { health, refusingServer, stopServer } from "../src/client.js";
import { tokenProof } from "../src/http-guard.js";
import { name } from "../src/identity.js";
import { closedPort, stallNextTick, stallOnConnect } from "./helpers/stall.js";

// A daemon that crashed leaves its record; once its pid belongs to another process, only the port
// can tell. A start stalled past the probe's 1.5 s timeout comes back to the port's refusal and an
// expired timer at once, and the refusal is the answer, or the start names a daemon that is not there.
test("a start stalled past the probe's timeout does not take a closed port for a daemon that refused to stop", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-client-"));
  const record = { port: await closedPort(), pid: process.pid, token: "a".repeat(64) };
  writeFileSync(join(dir, "server.json"), JSON.stringify(record));
  stallNextTick(2_000);
  assert.equal(await refusingServer(dir), null);
});

test("a health probe stalled past its timeout still reads a server that proves its token", async () => {
  const token = "b".repeat(64);
  const server = createServer((req, res) => {
    const challenge = new URL(req.url, "http://127.0.0.1").searchParams.get("challenge");
    res.end(JSON.stringify({ app: name, pid: process.pid, proof: tokenProof(token, challenge) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    stallNextTick(2_000);
    const status = await health({ port: server.address().port, token });
    assert.equal(status?.proven, true);
  } finally {
    server.close();
  }
});

// The stop probe's deadline is STOP_TIMEOUT_MS (5 s), so this stall spans it.
test("a stop whose refusal is read after a stall past its deadline reports the daemon stopped", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-client-"));
  const server = createServer((req, res) => {
    res.end("{}");
    server.close();
    stallOnConnect(5_500);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const info = { port: server.address().port, token: "c".repeat(64), pid: process.pid };
  assert.equal(await stopServer(dir, info, { proven: true, pid: process.pid }), true);
});
