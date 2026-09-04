import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pastSharingViolations, readJson, stateDir, writeJsonAtomic } from "../src/state-dir.js";
import { assertPrivate, loosen, ownerOnly } from "./helpers/private.js";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-state-"));

test("the state directory is private to the user and re-tightened when it already exists", () => {
  const dir = join(scratch(), "state");
  assert.equal(stateDir({ POINTBACK_STATE_DIR: dir }), dir);
  assertPrivate(dir, 0o700);
  loosen(dir);
  assert.equal(ownerOnly(dir), false, "the loosening this test re-tightens did nothing");
  stateDir({ POINTBACK_STATE_DIR: dir });
  assertPrivate(dir, 0o700);
});

test("writes are atomic, owner-only, and leave no temp file behind", () => {
  const dir = scratch();
  const file = join(dir, "state.json");
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assertPrivate(file, 0o600);
  assert.deepEqual(readJson(file), { a: 2 });
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("readJson falls back on a missing or corrupt file", () => {
  const dir = scratch();
  assert.equal(readJson(join(dir, "missing.json")), null);
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(readJson(join(dir, "bad.json"), { sessions: {} }), { sessions: {} });
  assert.equal(readFileSync(join(dir, "bad.json"), "utf8"), "{not json");
});

// Windows refuses a replace-rename while any other process merely has the destination open, and
// this daemon's own CLI reads `server.json` every 50 ms while waiting for it to come up. On run
// 33877405478, attempt 6, the two met: the daemon threw EPERM out of `rename` into `server.json`,
// exited 1, and the CLI reported a server that would not start. The collision lasts as long as
// one read, so it is waited out - and only it, because a directory that is genuinely not
// writable has to fail now rather than in a quarter of a second.
test("a write held off by a concurrent reader is retried; any other failure is not", () => {
  let attempts = 0;
  const held = () => {
    attempts += 1;
    if (attempts < 3)
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return "written";
  };
  assert.equal(pastSharingViolations(held, { pauseMs: 1 }), "written");
  assert.equal(attempts, 3);

  let tries = 0;
  assert.throws(
    () =>
      pastSharingViolations(
        () => {
          tries += 1;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
        { pauseMs: 1 },
      ),
    /ENOSPC/,
  );
  assert.equal(tries, 1, "a failure a reader cannot have caused is raised at once");

  let forever = 0;
  assert.throws(
    () =>
      pastSharingViolations(
        () => {
          forever += 1;
          throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        },
        { attempts: 4, pauseMs: 1 },
      ),
    /EBUSY/,
  );
  assert.equal(forever, 4, "and a reader that never lets go still gives up");
});
