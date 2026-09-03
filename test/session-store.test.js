import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { limits } from "../src/limits.js";
import { SessionStore } from "../src/session-store.js";

function lab() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-store-"));
  const artifact = join(dir, "plan.html");
  writeFileSync(artifact, "<p>plan</p>");
  return { dir, artifact, file: join(dir, "state.json") };
}

const prompt = (text = "Make it shorter") => ({
  prompt: text,
  selector: "#t",
  tag: "h1",
  text: "Title",
});

test("a key that names an inherited property never resolves to an object", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  store.open(artifact);
  for (const key of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "0000000000000000",
  ]) {
    assert.throws(
      () => store.get(key),
      (e) => e.status === 404,
      key,
    );
    assert.throws(
      () => store.queue(key, [prompt()]),
      (e) => e.status === 404,
      key,
    );
  }
  assert.equal(Object.prototype.status, undefined);
});

test("a poisoned state file is skipped entry by entry, not trusted", () => {
  const { file } = lab();
  // Repeated digit rather than a written-out 16-hex literal: a session key's
  // shape reads as a credential to a secret scanner, and this is a fixture.
  const key = "0".repeat(16);
  writeFileSync(
    file,
    JSON.stringify({
      sessions: {
        __proto__: { assetToken: "0".repeat(32), chat: [] },
        zzzz: { assetToken: "0".repeat(32) },
        [key]: { key, assetToken: "not-a-token" },
      },
    }),
  );
  const store = new SessionStore(file);
  assert.throws(
    () => store.get(key),
    (e) => e.status === 404,
  );
  assert.equal(Object.prototype.assetToken, undefined);
});

test("opening the same file twice yields one session, and it survives a restart", () => {
  const { file, artifact, dir } = lab();
  const store = new SessionStore(file);
  const a = store.open(artifact);
  const b = store.open(join(dir, ".", "plan.html"));
  assert.equal(a, b);
  assert.match(a.assetToken, /^[0-9a-f]{32}$/);
  store.queue(a.key, [prompt()]);
  const reopened = new SessionStore(file);
  assert.equal(reopened.get(a.key).assetToken, a.assetToken);
  assert.equal(reopened.take(a.key).length, 1);
  assert.equal(reopened.bootstrap(a.key).chat.length, 1);
  assert.equal(readFileSync(file, "utf8").includes("nextUid"), true);
});

test("prompts are validated field by field", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const bad = [
    [[], "prompts[] required"],
    ["nope", "prompts[] required"],
    [[null], "must be an object"],
    [[{ ...prompt(), prompt: 7 }], "prompt.prompt must be a string"],
    [[{ ...prompt(), prompt: "   " }], "prompt.prompt is empty"],
    [[{ ...prompt(), selector: undefined }], "prompt.selector must be a string"],
    [[prompt("x".repeat(limits.promptTextChars + 1))], "over"],
    [
      Array.from({ length: limits.promptsPerRequest + 1 }, () => prompt()),
      "too many prompts in one request",
    ],
  ];
  for (const [prompts, message] of bad) {
    assert.throws(
      () => store.queue(key, prompts),
      (e) => e.status === 400 && e.message.includes(message),
      message,
    );
  }
  assert.deepEqual(store.take(key), []);
});

test("uids are monotonic per session and extra fields are dropped", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  store.queue(key, [{ ...prompt("one"), evil: "x" }, prompt("two")]);
  store.queue(key, [prompt("three")]);
  const taken = store.take(key);
  assert.deepEqual(
    taken.map((p) => [p.uid, p.prompt]),
    [
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ],
  );
  assert.equal("evil" in taken[0], false);
  assert.deepEqual(store.bootstrap(key).chat[0].target, {
    selector: "#t",
    tag: "h1",
    text: "Title",
  });
});

test("pending prompts, chat entries and sessions are capped", () => {
  const { file, artifact, dir } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const batch = Array.from({ length: limits.promptsPerRequest }, () => prompt());
  for (let i = 0; i < limits.pendingPromptsPerSession / limits.promptsPerRequest; i += 1)
    store.queue(key, batch);
  assert.throws(
    () => store.queue(key, [prompt()]),
    (e) => e.status === 429,
  );
  assert.equal(
    store.get(key).chat.length,
    Math.min(limits.pendingPromptsPerSession, limits.chatEntriesPerSession),
  );
  for (let i = 1; i < limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    store.open(extra);
  }
  const oneMore = join(dir, "one-more.html");
  writeFileSync(oneMore, "<p></p>");
  assert.throws(
    () => store.open(oneMore),
    (e) => e.status === 429,
  );
});

test("a poller wakes on feedback, times out to waiting, and a losing poller keeps waiting", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  assert.deepEqual(await store.waitForFeedback(key, 20), { status: "waiting" });
  const first = store.waitForFeedback(key, 5000);
  const second = store.waitForFeedback(key, 100);
  store.queue(key, [prompt()]);
  assert.equal((await first).prompts.length, 1);
  assert.deepEqual(await second, { status: "waiting" });
  const aborted = new AbortController();
  const third = store.waitForFeedback(key, 5000, aborted.signal);
  aborted.abort();
  assert.equal(await third, null);
});

test("presence follows the polls: waiting, listening, working, and back after the bound", async (t) => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const seen = [];
  store.on(key, (event) => event.type === "presence" && seen.push(event.state));
  assert.deepEqual(store.presence(key), { state: "waiting" });
  const poll = store.waitForFeedback(key, 5000);
  assert.deepEqual(store.presence(key), { state: "listening" });
  store.queue(key, [prompt()]);
  await poll;
  assert.equal(store.presence(key).state, "working");
  assert.match(store.presence(key).since, /^\d{4}-/);
  assert.equal(store.status(key).presence.state, "working");
  // A second poll while working is the agent coming back: listening again, then waiting on timeout.
  await store.waitForFeedback(key, 10);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  // Feedback taken at once (no attach) still counts as working, and working ages out on its own.
  store.queue(key, [prompt()]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await store.waitForFeedback(key, 10);
  assert.equal(store.presence(key).state, "working");
  t.mock.timers.tick(limits.workingMaxMs);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  t.mock.timers.reset();
  assert.deepEqual(seen, ["listening", "working", "listening", "waiting", "working", "waiting"]);
});

test("a file change bumps the revision, persists it and is announced", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const events = [];
  store.on(key, (event) => events.push(event));
  assert.equal(store.bumpRevision(key), 1);
  assert.equal(store.bumpRevision(key), 2);
  assert.deepEqual(events, [
    { type: "reload", revision: 1 },
    { type: "reload", revision: 2 },
  ]);
  assert.equal(new SessionStore(file).status(key).revision, 2);
});

test("ending queues the last prompts in the same step, wakes a waiting poll, and reopens", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  assert.throws(
    () => store.end(key, "user", [{ ...prompt(), prompt: "" }]),
    (e) => e.status === 400,
  );
  assert.equal(store.status(key).ended, null, "a refused prompt does not end the session");
  const events = [];
  store.on(key, (event) => events.push(event.type));
  assert.deepEqual(store.end(key, "user", [prompt("last")]), {
    status: "ended",
    ended_by: "user",
    queued: 1,
  });
  assert.deepEqual(events, ["ended"]);
  const final = await store.waitForFeedback(key, 5000);
  assert.equal(final.status, "feedback");
  assert.equal(final.prompts[0].prompt, "last");
  assert.equal(final.session_ended, true);
  assert.equal(final.ended_by, "user");
  assert.deepEqual(await store.waitForFeedback(key, 5000), { status: "ended", ended_by: "user" });
  assert.equal(store.presence(key).state, "waiting", "an ended session has no working agent");
  assert.equal(new SessionStore(file).status(key).ended.by, "user");

  store.reopen(key);
  assert.equal(store.status(key).ended, null);
  const waiting = store.waitForFeedback(key, 5000);
  store.end(key, "agent");
  assert.deepEqual(await waiting, { status: "ended", ended_by: "agent" });
});

test("concurrent polls are capped", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const polls = Array.from({ length: limits.concurrentPolls }, () =>
    store.waitForFeedback(key, 50),
  );
  assert.throws(
    () => store.waitForFeedback(key, 50),
    (e) => e.status === 429,
  );
  await Promise.all(polls);
});
