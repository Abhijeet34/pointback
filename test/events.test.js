import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EventStreams } from "../src/events.js";
import { SessionStore } from "../src/session-store.js";
import { DEBOUNCE_MS } from "../src/watch.js";

function lab() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-events-"));
  const artifact = join(dir, "plan.html");
  writeFileSync(artifact, "<p>one</p>");
  const store = new SessionStore(join(dir, "state.json"));
  const { key } = store.open(artifact);
  return { dir, artifact, store, key, streams: new EventStreams(store) };
}

/** A tab: the lines it received, and the detach its connection close would run. */
function tab(streams, key) {
  const lines = [];
  const detach = streams.open(key, (event) => lines.push(event));
  return { lines, detach, types: () => lines.map((line) => line.type) };
}

test("a tab is greeted with the state it must match, and a saved file reloads it", async () => {
  const { artifact, key, streams } = lab();
  const one = tab(streams, key);
  assert.deepEqual(one.lines[0], {
    type: "hello",
    revision: 0,
    presence: { state: "waiting" },
    ended: null,
  });
  await sleep(150);
  writeFileSync(artifact, "<p>two</p>");
  await sleep(DEBOUNCE_MS * 4);
  assert.deepEqual(one.lines.at(-1), { type: "reload", revision: 1 });
  one.detach();
  assert.equal(streams.size, 0);
});

test("a second tab takes the review, and closing it hands the review back", () => {
  const { key, streams, store } = lab();
  const one = tab(streams, key);
  const two = tab(streams, key);
  assert.equal(streams.size, 2);
  assert.deepEqual(one.types(), ["hello", "superseded"], "the first tab is told at once");
  assert.deepEqual(two.types(), ["hello"]);
  store.bumpRevision(key);
  assert.deepEqual(one.lines.at(-1), { type: "reload", revision: 1 }, "both tabs stay informed");
  assert.deepEqual(two.lines.at(-1), { type: "reload", revision: 1 });
  two.detach();
  assert.deepEqual(one.lines.at(-1), {
    type: "current",
    revision: 1,
    presence: { state: "waiting" },
    ended: null,
  });
  // A tab that was never current leaves without disturbing the one that is.
  const three = tab(streams, key);
  three.detach();
  assert.deepEqual(one.lines.at(-1).type, "current");
  one.detach();
  assert.equal(streams.size, 0);
});

test("presence, the end and a reopen all reach the tab; feedback does not", async () => {
  const { key, streams, store } = lab();
  const one = tab(streams, key);
  const poll = store.waitForFeedback(key, 30);
  await poll;
  store.queue(key, [{ prompt: "x", selector: "p", tag: "p", text: "one" }]);
  store.end(key, "user");
  store.reopen(key);
  assert.deepEqual(one.types(), ["hello", "presence", "presence", "ended", "reopened"]);
  one.detach();
});

test("a vanished file does not throw, and closeAll leaves nothing watching", async () => {
  const { dir, key, streams } = lab();
  const one = tab(streams, key);
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  await sleep(200);
  assert.deepEqual(one.types(), ["hello"], "a file that goes away is not a revision");
  streams.closeAll();
  assert.equal(streams.size, 0);
  // Detaching after the hub was closed is the ordinary shutdown race, not an error.
  one.detach();
});
