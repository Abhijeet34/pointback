import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FILES, SOURCE, sha256 } from "../scripts/sync-house.js";

const browser = new URL("../src/browser/", import.meta.url);
const read = (path) => readFileSync(new URL(path, browser), "utf8");
const pin = JSON.parse(read("house/pin.json"));

test("the vendored house files are the pinned commit's bytes", () => {
  assert.equal(pin.source, SOURCE);
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(pin.files).sort(), Object.keys(FILES).sort());
  for (const [local, { from, sha256: digest }] of Object.entries(pin.files)) {
    assert.equal(from, FILES[local]);
    assert.equal(
      sha256(readFileSync(new URL(`house/${local}`, browser))),
      digest,
      `house/${local} differs from ${from} at ${pin.commit}; rerun scripts/sync-house.js`,
    );
  }
});
