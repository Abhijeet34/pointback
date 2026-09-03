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

test("a poller wakes on feedback, times out to null, and a losing poller keeps waiting", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  assert.equal(await store.waitForFeedback(key, 20), null);
  const first = store.waitForFeedback(key, 5000);
  const second = store.waitForFeedback(key, 100);
  store.queue(key, [prompt()]);
  assert.equal((await first).length, 1);
  assert.equal(await second, null);
  const aborted = new AbortController();
  const third = store.waitForFeedback(key, 5000, aborted.signal);
  aborted.abort();
  assert.equal(await third, null);
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
