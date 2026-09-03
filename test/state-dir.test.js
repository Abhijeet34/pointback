import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, stateDir, writeJsonAtomic } from "../src/state-dir.js";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-state-"));

test("the state directory is private to the user and re-tightened when it already exists", () => {
  const dir = join(scratch(), "state");
  assert.equal(stateDir({ POINTBACK_STATE_DIR: dir }), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  chmodSync(dir, 0o755);
  stateDir({ POINTBACK_STATE_DIR: dir });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("writes are atomic, owner-only, and leave no temp file behind", () => {
  const dir = scratch();
  const file = join(dir, "state.json");
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
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
