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
  assert.deepEqual(store.bootstrap(key).chat[0], {
    role: "user",
    uid: 1,
    at: taken[0].at,
    prompt: "one",
    selector: "#t",
    tag: "h1",
    text: "Title",
  });
});

test("a target is rebuilt field by field, and an anchor that cannot be trusted is refused", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const range = { type: "text-range", start: 3, end: 40, before: "", after: " cron" };
  store.queue(key, [
    { ...prompt("passage"), tag: "text", target: { ...range, path: [0], evil: "x" } },
    { ...prompt("cell"), tag: "td", target: { type: "table-cell", column: "Owner", span: 2 } },
  ]);
  const taken = store.take(key);
  assert.deepEqual(taken[0].target, range);
  assert.deepEqual(taken[1].target, { type: "table-cell", column: "Owner" });

  const bad = [
    [7, "target must be an object"],
    [{ type: "mermaid-node", id: "n1" }, "unknown target.type"],
    [{ ...range, start: "3" }, "target.start must be a non-negative integer"],
    [{ ...range, start: -1 }, "target.start must be a non-negative integer"],
    [{ ...range, start: 40, end: 40 }, "target.end must be after target.start"],
    [{ ...range, before: "x".repeat(65) }, "target.before over 64 characters"],
    [{ ...range, after: 0 }, "target.after must be a string"],
    [{ type: "table-cell", row: "x".repeat(201) }, "target.row over 200 characters"],
  ];
  for (const [target, message] of bad) {
    assert.throws(
      () => store.queue(key, [{ ...prompt(), target }]),
      (e) => e.status === 400 && e.message === message,
      message,
    );
  }
  assert.deepEqual(store.take(key), []);
});

test("the page outline is bounded, replaced with each batch, and delivered with the prompts", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  store.queue(key, [prompt()], "main\n  #title");
  assert.deepEqual(await store.waitForFeedback(key, 20), {
    status: "feedback",
    prompts: [{ uid: 1, at: store.get(key).chat[0].at, ...prompt() }],
    structure: "main\n  #title",
    receipt: 1,
  });

  // Each later poll acknowledges the batch before it, so the next one is delivered rather than resent.
  store.queue(key, [prompt()], "main\n  #other");
  assert.equal((await store.waitForFeedback(key, 20, undefined, 1)).structure, "main\n  #other");
  store.queue(key, [prompt()]);
  assert.equal(
    (await store.waitForFeedback(key, 20, undefined, 2)).structure,
    "main\n  #other",
    "a batch that outlines nothing keeps the last outline rather than clearing it",
  );

  // Send-and-end carries a last batch, so it carries the outline that batch was written against.
  store.end(key, "user", [prompt()], "main\n  #last");
  const final = await store.waitForFeedback(key, 20, undefined, 3);
  assert.equal(final.structure, "main\n  #last");
  assert.equal(final.session_ended, true);
  store.reopen(key);

  for (const [structure, message] of [
    [7, "structure must be a string"],
    ["x".repeat(limits.structureChars + 1), `structure over ${limits.structureChars} characters`],
  ]) {
    assert.throws(
      () => store.queue(key, [prompt()], structure),
      (e) => e.status === 400 && e.message === message,
      message,
    );
  }
});

test("pending prompts and chat entries are capped", () => {
  const { file, artifact } = lab();
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
});

test("sessions are bounded: opening past the cap disposes the oldest instead of wedging", () => {
  const { file, artifact, dir } = lab();
  const store = new SessionStore(file);
  const first = store.open(artifact).key;
  const keys = [first];
  for (let i = 1; i < limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    keys.push(store.open(extra).key);
  }
  // At the cap, a brand-new file opens rather than being refused, and the count stays bounded.
  const oneMore = join(dir, "one-more.html");
  writeFileSync(oneMore, "<p></p>");
  const fresh = store.open(oneMore).key;
  assert.equal(store.count, limits.sessions, "the session count never grows past the cap");
  assert.ok(store.get(fresh).file.endsWith("one-more.html"), "the fresh review opened");
  // The oldest, least-recently-active session is the one disposed, so a review is bounded and a
  // machine holds at most `limits.sessions` sessions no matter how many files have been reviewed.
  assert.throws(
    () => store.get(first),
    (e) => e.status === 404,
    "the least-recently-active session was disposed",
  );
});

test("an ended review is disposed before a live one, and a polled session is never disposed", async () => {
  const { file, artifact, dir } = lab();
  const store = new SessionStore(file);
  const live = store.open(artifact).key;
  const files = [];
  for (let i = 1; i < limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    files.push(extra);
    store.open(extra);
  }
  // End the second-opened session so it becomes the preferred eviction candidate.
  const endedKey = store.keyFor(files[0]);
  store.end(endedKey, "user");
  // Hold a poll on the oldest session so it cannot be the victim despite its age.
  const aborted = new AbortController();
  const held = store.waitForFeedback(live, 5000, aborted.signal);
  const oneMore = join(dir, "one-more.html");
  writeFileSync(oneMore, "<p></p>");
  store.open(oneMore);
  assert.throws(
    () => store.get(endedKey),
    (e) => e.status === 404,
    "the ended review was disposed before the older live one",
  );
  assert.equal(store.get(live).key, live, "the session with a poll attached was kept");
  aborted.abort();
  assert.equal(await held, null);
});

test("a session with undelivered notes is never disposed, even when it is the oldest", async () => {
  const { file, artifact, dir } = lab();
  const store = new SessionStore(file);
  const live = store.open(artifact).key;
  // Deliver a batch to `live` but never acknowledge it, so it sits in `unacked`. This also touches
  // lastActive, but every session opened below is touched later still, so `live` remains the
  // least-recently-active session by the time the cap is hit - the case the old filter mishandled.
  store.queue(live, [prompt("keep me")]);
  const delivered = await store.waitForFeedback(live, 20);
  assert.equal(delivered.status, "feedback");
  const emptyKeys = [];
  for (let i = 1; i < limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    emptyKeys.push(store.open(extra).key);
  }
  assert.equal(store.count, limits.sessions);
  const oneMore = join(dir, "one-more.html");
  writeFileSync(oneMore, "<p></p>");
  store.open(oneMore);
  assert.equal(store.get(live).key, live, "the session holding an unacked batch survived eviction");
  assert.throws(
    () => store.get(emptyKeys[0]),
    (e) => e.status === 404,
    "the oldest fully-delivered, empty session was disposed instead",
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
  const delivered = await first;
  assert.equal(delivered.prompts.length, 1);
  assert.deepEqual(await second, { status: "waiting" });
  // A poll that has acknowledged the batch and is then aborted resolves null, with nothing to lose.
  const aborted = new AbortController();
  const third = store.waitForFeedback(key, 5000, aborted.signal, delivered.receipt);
  aborted.abort();
  assert.equal(await third, null);
});

test("a batch whose delivery is lost is redelivered by uid until the agent acknowledges it", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  store.queue(key, [prompt("keep me")], "main\n  #t");
  const first = await store.waitForFeedback(key, 20);
  assert.equal(first.status, "feedback");
  assert.equal(first.receipt, 1);
  assert.equal(store.get(key).pending.length, 0, "the batch leaves the queue when it is taken");
  // The response never reached the agent, so a fresh poll that has acknowledged nothing gets it again.
  const again = await store.waitForFeedback(key, 20);
  assert.deepEqual(
    again.prompts.map((p) => p.uid),
    [1],
    "redelivery keeps the uid, so an agent that sees a batch twice can tell it is a repeat",
  );
  assert.equal(again.structure, "main\n  #t");
  // Once the agent acknowledges receipt, the batch is cleared and a later poll waits for new notes.
  assert.deepEqual(await store.waitForFeedback(key, 10, undefined, 1), { status: "waiting" });
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
  // A second poll while working is the agent coming back, acknowledging the batch it took: listening
  // again, then waiting on timeout.
  await store.waitForFeedback(key, 10, undefined, 1);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  // Feedback taken at once (no attach) still counts as working, and working ages out on its own.
  store.queue(key, [prompt()]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await store.waitForFeedback(key, 10, undefined, 1);
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
  // Acknowledging the final batch clears it, so the next poll sees only the ended notice.
  assert.deepEqual(await store.waitForFeedback(key, 5000, undefined, final.receipt), {
    status: "ended",
    ended_by: "user",
  });
  assert.equal(store.presence(key).state, "waiting", "an ended session has no working agent");
  assert.equal(new SessionStore(file).status(key).ended.by, "user");

  store.reopen(key);
  assert.equal(store.status(key).ended, null);
  const waiting = store.waitForFeedback(key, 5000);
  store.end(key, "agent");
  assert.deepEqual(await waiting, { status: "ended", ended_by: "agent" });
});

test("ending while the agent is working says so, so no tab is left holding a disabled Send", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  store.queue(key, [prompt()]);
  await store.waitForFeedback(key, 5000);
  assert.equal(store.presence(key).state, "working");
  const seen = [];
  store.on(key, (event) => event.type === "presence" && seen.push(event.state));
  store.end(key, "user");
  assert.deepEqual(seen, ["waiting"], "the tab is told the agent is no longer working");
  assert.equal(store.presence(key).state, "waiting");
  store.reopen(key);
  assert.equal(store.presence(key).state, "waiting", "and a reopened review has no working agent");
});

test("an agent end never relabels a review the reviewer ended", () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  store.end(key, "user");
  assert.deepEqual(store.end(key, "agent"), { status: "ended", ended_by: "user", queued: 0 });
  assert.equal(store.status(key).ended.by, "user");
  assert.equal(new SessionStore(file).status(key).ended.by, "user");
});

test("each note keeps the time it was written, and an unusable stamp falls back to arrival", async () => {
  const { file, artifact } = lab();
  const store = new SessionStore(file);
  const { key } = store.open(artifact);
  const written = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.queue(key, [
    { ...prompt("first"), at: written },
    prompt("second"),
    { ...prompt("third"), at: "half past nine" },
    { ...prompt("fourth"), at: new Date(Date.now() + 60_000).toISOString() },
    { ...prompt("fifth"), at: new Date(2000, 0, 1).toISOString() },
  ]);
  const { prompts } = await store.waitForFeedback(key, 5000);
  const arrived = prompts[1].at;
  assert.equal(prompts[0].at, written, "the note carries when the reviewer wrote it");
  assert.ok(prompts[0].at < arrived, "which is not the moment the batch arrived");
  assert.equal(prompts[2].at, arrived, "a stamp that is not a time is not usable");
  assert.equal(prompts[3].at, arrived, "nor one from the future");
  assert.equal(prompts[4].at, arrived, "nor one from before the review opened");
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
