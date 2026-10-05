import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refusingServer } from "../src/client.js";
import { closedPort, stallNextTick } from "./helpers/stall.js";

// A daemon that crashed leaves its record; once its pid belongs to another process, only the port
// can tell. A start stalled past the probe's 1.5 s timeout comes back to the port's refusal and an
// expired timer at once, and the refusal is the answer, or the start names a daemon that is not there.
test("a start stalled past the probe's timeout does not take a closed port for a daemon that refused to stop", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-client-"));
  const record = { port: await closedPort(), pid: process.pid, token: "a".repeat(64) };
  writeFileSync(join(dir, "server.json"), JSON.stringify(record));
  const refusing = refusingServer(dir);
  stallNextTick(2_000);
  assert.equal(await refusing, null);
});
