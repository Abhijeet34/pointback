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

test("the chrome loads the house in order and pins dark", () => {
  const html = read("chrome.html");
  assert.match(html, /<html lang="en" data-theme="dark">/);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets, [
    "/house/brand.tokens.css",
    "/house/roles.css",
    "/house/scales.css",
    "/chrome.css",
  ]);
});

// A misspelt role is not an error in CSS, just a property that silently falls back.
test("every house name the chrome uses is one the house defines", () => {
  const defined = new Set(
    Object.keys(FILES).flatMap((local) =>
      [...read(`house/${local}`).matchAll(/(--hw-[\w-]+)\s*:/g)].map((m) => m[1]),
    ),
  );
  const used = new Set([...read("chrome.css").matchAll(/var\((--hw-[\w-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) assert.ok(defined.has(name), `${name} is not a house role`);
});

test("nothing in the chrome loops", () => {
  assert.doesNotMatch(read("chrome.css"), /infinite|@keyframes/);
});
