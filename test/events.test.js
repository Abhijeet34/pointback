import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { EventStreams } from "../src/events.js";
import { SessionStore } from "../src/session-store.js";
import { until } from "./helpers/wait.js";
import { watchAvailable } from "./helpers/watch.js";

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

/**
 * The event types a tab may see that are not the subject of the test asking. Where fs.watch
 * cannot run, every stream carries a `reload-off`; where it can, nothing else is allowed in,
 * so a stray one still fails the assertion it would otherwise hide.
 */
const noise = async () => ((await watchAvailable()) ? [] : ["reload-off"]);
const only = (types, allowed) => types.filter((type) => !allowed.includes(type));

test("a tab is greeted with the state it must match, and a saved file reloads it", async () => {
  const watching = await watchAvailable();
  const { artifact, key, store, streams } = lab();
  const one = tab(streams, key);
  assert.deepEqual(one.lines[0], {
    type: "hello",
    artifactUrl: `/artifact/${key}/${store.get(key).assetToken}/plan.html`,
    revision: 0,
    presence: { state: "waiting" },
    ended: null,
    gone: false,
    drafts: [],
  });
  await sleep(150);
  writeFileSync(artifact, "<p>two</p>");
  // Waited for rather than slept past: how fast the platform's file watcher delivers is the
  // runner's business, and DEBOUNCE_MS * 4 was this assertion depending on it. Either line
  // ends the wait: where fs.watch cannot run, `reload-off` is the second line the tab sees.
  await until(() => one.lines.length > 1, {
    what: "the saved file to reach the tab",
    timeoutMs: 10_000,
  });
  assert.deepEqual(
    one.lines.at(-1),
    watching ? { type: "reload", revision: 1 } : { type: "reload-off" },
    watching
      ? "a saved file reloads the tab"
      : "no watching here, so the tab is told live reload is off rather than left waiting on it",
  );
  one.detach();
  assert.equal(streams.size, 0);
});

test("a second tab takes the review, and closing it hands the review back", () => {
  const { key, streams, store } = lab();
  assert.equal(streams.live(key), false, "no tab yet, so opening the file opens one");
  const one = tab(streams, key);
  const two = tab(streams, key);
  assert.equal(streams.size, 2);
  assert.equal(streams.live(key), true, "a tab shows the review, so opening the file opens none");
  assert.deepEqual(one.types(), ["hello", "superseded"], "the first tab is told at once");
  assert.deepEqual(two.types(), ["hello"]);
  store.fileChanged(key);
  assert.deepEqual(one.lines.at(-1), { type: "reload", revision: 1 }, "both tabs stay informed");
  assert.deepEqual(two.lines.at(-1), { type: "reload", revision: 1 });
  two.detach();
  assert.deepEqual(one.lines.at(-1), {
    type: "current",
    artifactUrl: `/artifact/${key}/${store.get(key).assetToken}/plan.html`,
    revision: 1,
    presence: { state: "waiting" },
    ended: null,
    gone: false,
    drafts: [],
  });
  // A tab that was never current leaves without disturbing the one that is.
  const three = tab(streams, key);
  three.detach();
  assert.deepEqual(one.lines.at(-1).type, "current");
  one.detach();
  assert.equal(streams.size, 0);
  assert.equal(streams.live(key), false, "the last tab gone, the next open opens one again");
});

test("presence, unsent notes, the end and a reopen all reach every tab; feedback does not", async () => {
  const { key, streams, store } = lab();
  const one = tab(streams, key);
  const poll = store.waitForFeedback(key, 30);
  await poll;
  store.addDraft(key, { prompt: "x", selector: "p", tag: "p", text: "one" });
  store.send(key);
  store.end(key, "user");
  store.reopen(key);
  assert.deepEqual(only(one.types(), await noise()), [
    "hello",
    "presence",
    "presence",
    "drafts",
    "drafts",
    "ended",
    "reopened",
  ]);
  const drafts = one.lines.filter((line) => line.type === "drafts").map((line) => line.drafts);
  assert.deepEqual(
    drafts.map((list) => list.map((d) => d.prompt)),
    [["x"], []],
    "a tab sees the note arrive and leave with Send",
  );
  one.detach();
});

test("a deleted file is gone rather than a revision, its return reloads, and closeAll leaves nothing watching", async () => {
  const watching = await watchAvailable();
  const { dir, artifact, key, streams } = lab();
  const one = tab(streams, key);
  await sleep(150);
  rmSync(artifact);
  if (watching) {
    await until(() => one.types().includes("gone"), {
      what: "the deletion to reach the tab",
      timeoutMs: 10_000,
    });
    writeFileSync(artifact, "<p>back again</p>");
    await until(() => one.types().includes("reload"), {
      what: "the file's return to reach the tab",
      timeoutMs: 10_000,
    });
    assert.deepEqual(one.types(), ["hello", "gone", "reload"]);
  } else {
    await sleep(200);
    assert.deepEqual(one.types(), ["hello", "reload-off"], "no watching here, so nothing more");
  }
  // A tab connecting while the file is away learns it from its greeting.
  rmSync(artifact, { force: true });
  const two = tab(streams, key);
  assert.equal(two.lines[0].gone, true);
  rmSync(dir, { recursive: true, force: true });
  await sleep(200);
  streams.closeAll();
  assert.equal(streams.size, 0);
  // Detaching after the hub was closed is the ordinary shutdown race, not an error.
  one.detach();
  two.detach();
});
