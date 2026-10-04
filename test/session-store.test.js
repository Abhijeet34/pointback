import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { limits } from "../src/limits.js";
import { EPOCH_PATTERN, SessionStore } from "../src/session-store.js";

function lab() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-store-"));
  const artifact = join(dir, "plan.html");
  writeFileSync(artifact, "<p>plan</p>");
  return { dir, artifact };
}

/** Where a session is kept on disk: one file per session, under the state directory. */
const sessionFile = (dir, key) => join(dir, "sessions", `${key}.json`);

/** What the CLI would send back: the high uid it received, in the session life that numbered it. */
const cursor = (store, key, uid) => ({ uid, epoch: store.get(key).epoch });

const prompt = (text = "Make it shorter") => ({
  prompt: text,
  selector: "#t",
  tag: "h1",
  text: "Title",
});

test("a key that names an inherited property never resolves to an object", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  const { dir } = lab();
  // Repeated digit rather than a written-out 16-hex literal: a session key's
  // shape reads as a credential to a secret scanner, and this is a fixture.
  const key = "0".repeat(16);
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      sessions: {
        __proto__: { assetToken: "0".repeat(32), chat: [] },
        zzzz: { assetToken: "0".repeat(32) },
        [key]: { key, assetToken: "not-a-token" },
      },
    }),
  );
  // A session's own file is held to the same: its name must be a key, and the key it records.
  const other = "1".repeat(16);
  mkdirSync(join(dir, "sessions"));
  writeFileSync(sessionFile(dir, "__proto__"), JSON.stringify({ assetToken: "0".repeat(32) }));
  writeFileSync(sessionFile(dir, other), JSON.stringify({ key, assetToken: "0".repeat(32) }));
  const store = new SessionStore(dir);
  for (const missing of [key, other])
    assert.throws(
      () => store.get(missing),
      (e) => e.status === 404,
    );
  assert.equal(Object.prototype.assetToken, undefined);
});

test("opening the same file twice yields one session, and it survives a restart", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const a = store.open(artifact);
  const b = store.open(join(dir, ".", "plan.html"));
  assert.equal(a, b);
  assert.match(a.assetToken, /^[0-9a-f]{32}$/);
  store.queue(a.key, [prompt()]);
  const reopened = new SessionStore(dir);
  assert.equal(reopened.get(a.key).assetToken, a.assetToken);
  assert.equal(reopened.take(a.key).length, 1);
  assert.equal(reopened.bootstrap(a.key).chat.length, 1);
  assert.equal(readFileSync(sessionFile(dir, a.key), "utf8").includes("nextUid"), true);
});

test("prompts are validated field by field", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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

test("source lines ride only on a Markdown file's notes, and only as two line numbers", () => {
  const { dir, artifact } = lab();
  const markdown = join(dir, "plan.md");
  writeFileSync(markdown, "# Plan\n\nOne\ntwo\n");
  const store = new SessionStore(dir);
  const md = store.open(markdown).key;
  const html = store.open(artifact).key;
  for (const lines of [[3], [0, 4], [4, 3], [3, 4.5], "3-4", null, [3, 4, 5]]) {
    assert.throws(
      () => store.addDraft(md, { ...prompt(), lines }),
      (e) => e.status === 400 && e.message === "prompt.lines must be [first, last] line numbers",
      JSON.stringify(lines),
    );
  }
  store.addDraft(md, { ...prompt(), lines: [3, 4] });
  // An HTML page that happens to carry the attribute names no source lines anyone can use.
  store.addDraft(html, { ...prompt(), lines: [3, 4] });
  store.send(md);
  store.send(html);
  assert.deepEqual(
    store.take(md).map((note) => note.lines),
    [[3, 4]],
  );
  assert.deepEqual(
    store.take(html).map((note) => "lines" in note),
    [false],
  );
});

test("uids are monotonic per session and extra fields are dropped", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const range = { type: "text-range", start: 3, end: 40, before: "", after: " cron" };
  const picture = { type: "media", alt: "Trend", src: "t.svg", x: 5, y: 0, width: 200, height: 80 };
  store.queue(key, [
    { ...prompt("passage"), tag: "text", target: { ...range, path: [0], evil: "x" } },
    { ...prompt("cell"), tag: "td", target: { type: "table-cell", column: "Owner", span: 2 } },
    { ...prompt("control"), tag: "button", target: { type: "control", name: "Upgrade", on: 1 } },
    { ...prompt("image"), tag: "img", target: { ...picture, onload: "x" } },
  ]);
  const taken = store.take(key);
  assert.deepEqual(taken[0].target, range);
  assert.deepEqual(taken[1].target, { type: "table-cell", column: "Owner" });
  assert.deepEqual(taken[2].target, { type: "control", name: "Upgrade" });
  assert.deepEqual(taken[3].target, picture);

  const bad = [
    [7, "target must be an object"],
    [{ type: "mermaid-node", id: "n1" }, "unknown target.type"],
    [{ ...range, start: "3" }, "target.start must be a non-negative integer"],
    [{ ...range, start: -1 }, "target.start must be a non-negative integer"],
    [{ ...range, start: 40, end: 40 }, "target.end must be after target.start"],
    [{ ...range, before: "x".repeat(65) }, "target.before over 64 characters"],
    [{ ...range, after: 0 }, "target.after must be a string"],
    [{ type: "table-cell", row: "x".repeat(201) }, "target.row over 200 characters"],
    [{ type: "control" }, "target.name must be a string"],
    [{ type: "control", name: "x".repeat(201) }, "target.name over 200 characters"],
    [{ ...picture, src: "x".repeat(2001) }, "target.src over 2000 characters"],
    [{ ...picture, x: -1 }, "target.x must be a non-negative integer"],
    [{ ...picture, height: 1.5 }, "target.height must be a non-negative integer"],
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  store.queue(key, [prompt()], "main\n  #title");
  assert.deepEqual(await store.waitForFeedback(key, 20), {
    status: "feedback",
    prompts: [{ uid: 1, at: store.get(key).chat[0].at, ...prompt() }],
    structure: "main\n  #title",
    receipt: 1,
    epoch: store.get(key).epoch,
  });

  // Each later poll acknowledges the batch before it, so the next one is delivered rather than resent.
  store.queue(key, [prompt()], "main\n  #other");
  assert.equal(
    (await store.waitForFeedback(key, 20, undefined, cursor(store, key, 1))).structure,
    "main\n  #other",
  );
  store.queue(key, [prompt()]);
  assert.equal(
    (await store.waitForFeedback(key, 20, undefined, cursor(store, key, 2))).structure,
    "main\n  #other",
    "a batch that outlines nothing keeps the last outline rather than clearing it",
  );

  // Send-and-end carries a last batch, so it carries the outline that batch was written against.
  store.addDraft(key, prompt(), "main\n  #last");
  store.end(key, "user", "send");
  const final = await store.waitForFeedback(key, 20, undefined, cursor(store, key, 3));
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  assert.equal(
    readdirSync(join(dir, "sessions")).length,
    limits.sessions,
    "and neither does what is kept on disk",
  );
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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

test("a session holding unsent notes is never disposed, even when it is the oldest", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const drafted = store.open(artifact).key;
  store.addDraft(drafted, prompt("not sent yet"));
  for (let i = 1; i <= limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    store.open(extra);
  }
  assert.equal(store.count, limits.sessions);
  assert.deepEqual(
    store.status(drafted).drafts.map((d) => d.prompt),
    ["not sent yet"],
    "the reviewer's unsent note outlived the cap",
  );
});

test("a session within a poll's grace is not evictable, and is once the grace passes", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const extra = (i) => {
    const file = join(dir, `extra-${i}.html`);
    writeFileSync(file, "<p></p>");
    return store.open(file).key;
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const idle = store.waitForFeedback(key, 10);
  t.mock.timers.tick(10);
  assert.deepEqual(await idle, { status: "waiting" });
  for (let i = 1; i < limits.sessions; i += 1) extra(i);
  extra(limits.sessions);
  assert.equal(store.get(key).key, key, "the session within its grace survived eviction");
  t.mock.timers.tick(limits.pollGraceMs);
  extra(limits.sessions + 1);
  assert.throws(
    () => store.get(key),
    (e) => e.status === 404,
    "the session was evictable once its grace passed",
  );
  t.mock.timers.reset();
});

// An evicted session opened again restarts its uids at 1. The agent's cursor from the old life
// still says 3, and before epochs it acknowledged the new life's first batch unseen.
test("a cursor from a session's earlier life acknowledges nothing in its next one", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const firstLife = store.get(key).epoch;
  assert.match(firstLife, EPOCH_PATTERN);
  store.queue(key, [prompt("one"), prompt("two"), prompt("three")]);
  const delivered = await store.waitForFeedback(key, 20);
  assert.equal(delivered.receipt, 3);
  assert.equal(delivered.epoch, firstLife);
  const stale = { uid: delivered.receipt, epoch: delivered.epoch };
  // The session is evictable only once that poll's grace has passed.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const idle = store.waitForFeedback(key, 10, undefined, stale);
  t.mock.timers.tick(10);
  assert.deepEqual(await idle, { status: "waiting" });
  t.mock.timers.tick(limits.pollGraceMs);
  t.mock.timers.reset();

  for (let i = 0; i < limits.sessions; i += 1) {
    const extra = join(dir, `extra-${i}.html`);
    writeFileSync(extra, "<p></p>");
    store.open(extra);
  }
  assert.throws(
    () => store.get(key),
    (e) => e.status === 404,
    "the session was evicted",
  );
  store.open(artifact);
  assert.notEqual(store.get(key).epoch, firstLife, "the session's next life has its own epoch");
  store.queue(key, [prompt("the note that must not be lost")]);

  // A poll takes the batch and its response is lost; the agent's next poll carries the old cursor.
  assert.equal((await store.waitForFeedback(key, 10)).receipt, 1);
  const again = await store.waitForFeedback(key, 10, undefined, stale);
  assert.equal(again.status, "feedback", "the stale cursor acknowledged nothing");
  assert.deepEqual(
    again.prompts.map((p) => [p.uid, p.prompt]),
    [[1, "the note that must not be lost"]],
  );
  const current = { uid: again.receipt, epoch: again.epoch };
  assert.deepEqual(await store.waitForFeedback(key, 10, undefined, current), {
    status: "waiting",
  });
});

test("a session stored before epochs gets one on load, and keeps it across restarts", async () => {
  const { dir, artifact } = lab();
  const first = new SessionStore(dir);
  const { key } = first.open(artifact);
  first.queue(key, [prompt()]);
  await first.waitForFeedback(key, 10);
  const stored = JSON.parse(readFileSync(sessionFile(dir, key), "utf8"));
  delete stored.epoch;
  writeFileSync(sessionFile(dir, key), JSON.stringify(stored));

  const upgraded = new SessionStore(dir);
  const epoch = upgraded.get(key).epoch;
  assert.match(epoch, EPOCH_PATTERN);
  assert.equal(new SessionStore(dir).get(key).epoch, epoch, "the new epoch was persisted");
  // Without one, no cursor could ever match and the outstanding batch would come back forever.
  const redelivered = await upgraded.waitForFeedback(key, 10);
  assert.equal(redelivered.epoch, epoch);
  assert.deepEqual(await upgraded.waitForFeedback(key, 10, undefined, { uid: 1, epoch }), {
    status: "waiting",
  });
});

test("a session stored before roots resolves its assets in the file's own folder", () => {
  const { dir, artifact } = lab();
  const { key } = new SessionStore(dir).open(artifact);
  const stored = JSON.parse(readFileSync(sessionFile(dir, key), "utf8"));
  delete stored.root;
  writeFileSync(sessionFile(dir, key), JSON.stringify(stored));

  const upgraded = new SessionStore(dir);
  assert.equal(upgraded.get(key).root, dirname(realpathSync.native(artifact)));
  assert.equal(upgraded.status(key).artifactUrl.split("/").pop(), "plan.html");
  assert.equal(new SessionStore(dir).get(key).root, upgraded.get(key).root, "and it was persisted");
});

test("a moved file's session still delivers what it holds, then answers gone and tells the tab", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const events = [];
  store.on(key, (event) => events.push(event.type));
  store.queue(key, [prompt("taken before the move")]);
  renameSync(artifact, join(dir, "moved.html"));

  assert.equal(store.keyFor(artifact), key, "the old path still names its session");
  assert.equal(store.status(key).gone, true);
  const held = await store.waitForFeedback(key, 10);
  assert.equal(held.status, "feedback", "notes queued before the move are still delivered");
  const gone = { status: "gone", file: store.get(key).file };
  assert.deepEqual(await store.waitForFeedback(key, 10, undefined, cursor(store, key, 1)), gone);
  assert.deepEqual(store.end(key, "agent"), gone, "an end answers the same");
  assert.equal(store.status(key).ended, null, "and ends nothing");
  assert.deepEqual(
    events.filter((type) => type === "gone"),
    ["gone", "gone"],
    "every open tab is told, by the poll and by the end",
  );

  // A poll already waiting when the watcher sees the file go is answered at once.
  const waiting = store.waitForFeedback(key, 5000, undefined, cursor(store, key, 1));
  store.fileChanged(key);
  assert.deepEqual(await waiting, gone);

  renameSync(join(dir, "moved.html"), artifact);
  assert.equal(store.status(key).gone, false);
  assert.equal(store.fileChanged(key), 1, "a file that comes back is a new revision");
  assert.deepEqual(await store.waitForFeedback(key, 10, undefined, cursor(store, key, 1)), {
    status: "waiting",
  });
});

test("a poller wakes on feedback, times out to waiting, and a losing poller keeps waiting", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  const third = store.waitForFeedback(
    key,
    5000,
    aborted.signal,
    cursor(store, key, delivered.receipt),
  );
  aborted.abort();
  assert.equal(await third, null);
});

test("a batch whose delivery is lost is redelivered by uid until the agent acknowledges it", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  assert.deepEqual(await store.waitForFeedback(key, 10, undefined, cursor(store, key, 1)), {
    status: "waiting",
  });
});

test("presence follows the polls: waiting, listening, working, and back after the bound", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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
  // again, then waiting once its grace passes after the timeout.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const idle = store.waitForFeedback(key, 10, undefined, cursor(store, key, 1));
  t.mock.timers.tick(10);
  await idle;
  t.mock.timers.tick(limits.pollGraceMs);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  // Feedback taken at once (no attach) still counts as working, and working ages out on its own.
  store.queue(key, [prompt()]);
  await store.waitForFeedback(key, 10, undefined, cursor(store, key, 1));
  assert.equal(store.presence(key).state, "working");
  t.mock.timers.tick(limits.workingMaxMs);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  t.mock.timers.reset();
  assert.deepEqual(seen, ["listening", "working", "listening", "waiting", "working", "waiting"]);
});

// A long poll is a run of requests (`poll` in src/cli.js); the tab must not see the agent leave and
// come back between two of them, and must still see an agent that really stopped.
test("presence stays listening across a re-poll inside the grace, and turns waiting once the agent stops", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const seen = [];
  store.on(key, (event) => event.type === "presence" && seen.push(event.state));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = async (ack) => {
    const answer = store.waitForFeedback(key, 100, undefined, ack);
    t.mock.timers.tick(100);
    return answer;
  };
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await request(), { status: "waiting" });
    t.mock.timers.tick(limits.pollGraceMs - 1);
    assert.equal(store.presence(key).state, "listening", `after request ${i + 1}`);
  }
  assert.deepEqual(seen, ["listening"], "three boundaries inside the grace change nothing");
  // A note sent inside a grace is answered by the next request at once: listening to working.
  store.queue(key, [prompt()]);
  assert.equal((await request()).status, "feedback");
  assert.deepEqual(seen, ["listening", "working"]);
  // The agent acknowledges, waits out one request, and stops: listening until the grace is over.
  assert.deepEqual(await request(cursor(store, key, 1)), { status: "waiting" });
  t.mock.timers.tick(limits.pollGraceMs - 1);
  assert.equal(store.presence(key).state, "listening");
  t.mock.timers.tick(1);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  assert.deepEqual(seen, ["listening", "working", "listening", "waiting"]);
  t.mock.timers.reset();
});

test("a poll woken by the end of the review or a gone file leaves presence at once, with no grace", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const ended = store.waitForFeedback(key, 5000);
  store.end(key, "agent");
  assert.equal((await ended).status, "ended");
  assert.equal(store.presence(key).state, "waiting");
  const moved = lab();
  const other = new SessionStore(moved.dir);
  const { key: movedKey } = other.open(moved.artifact);
  const gone = other.waitForFeedback(movedKey, 5000);
  rmSync(moved.artifact);
  other.fileChanged(movedKey);
  assert.equal((await gone).status, "gone");
  assert.equal(other.presence(movedKey).state, "waiting");
});

test("a poll whose connection drops stays listening through the grace, then shows waiting", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const poll = store.waitForFeedback(key, 5000, controller.signal);
  controller.abort();
  assert.equal(await poll, null);
  assert.equal(store.presence(key).state, "listening");
  t.mock.timers.tick(limits.pollGraceMs - 1);
  assert.equal(store.presence(key).state, "listening");
  t.mock.timers.tick(1);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  t.mock.timers.reset();
});

test("an attach inside a grace clears working, so the tab does not show working after the agent came back", async (t) => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = store.waitForFeedback(key, 5000);
  const second = store.waitForFeedback(key, 5000);
  store.queue(key, [prompt()]);
  assert.equal((await first).status, "feedback");
  assert.equal(store.presence(key).state, "listening");
  t.mock.timers.tick(5000);
  assert.deepEqual(await second, { status: "waiting" });
  const third = store.waitForFeedback(key, 100, undefined, cursor(store, key, 1));
  assert.deepEqual(store.presence(key), { state: "listening" });
  t.mock.timers.tick(100);
  assert.deepEqual(await third, { status: "waiting" });
  t.mock.timers.tick(limits.pollGraceMs);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  t.mock.timers.reset();
});

test("a file change bumps the revision, persists it and is announced", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const events = [];
  store.on(key, (event) => events.push(event));
  assert.equal(store.fileChanged(key), 1);
  assert.equal(store.fileChanged(key), 2);
  assert.deepEqual(events, [
    { type: "reload", revision: 1 },
    { type: "reload", revision: 2 },
  ]);
  assert.equal(new SessionStore(dir).status(key).revision, 2);
});

test("a send names the notes it moved in the one event that clears them; a discard names none", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const events = [];
  store.on(key, (event) => event.type === "drafts" && events.push(event));
  store.addDraft(key, prompt("first"));
  store.addDraft(key, prompt("second"));
  store.send(key);
  store.addDraft(key, prompt("last"));
  store.end(key, "user", "send");
  store.reopen(key);
  store.addDraft(key, prompt("dropped"));
  store.end(key, "user", "discard");
  assert.deepEqual(
    events.map((event) => event.sent?.map((note) => [note.uid, note.prompt])),
    [
      undefined,
      undefined,
      [
        [1, "first"],
        [2, "second"],
      ],
      undefined,
      [[3, "last"]],
      undefined,
      undefined,
    ],
  );
  assert.deepEqual([...events[2].sent, ...events[4].sent], store.status(key).chat);
});

test("ending queues the last prompts in the same step, wakes a waiting poll, and reopens", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  assert.throws(
    () => store.addDraft(key, { ...prompt(), prompt: "" }),
    (e) => e.status === 400,
  );
  store.addDraft(key, prompt("last"));
  const events = [];
  store.on(key, (event) => events.push(event.type));
  assert.deepEqual(store.end(key, "user", "send"), {
    status: "ended",
    ended_by: "user",
    queued: 1,
  });
  assert.deepEqual(events, ["drafts", "ended"], "every tab sees the notes leave, then the end");
  assert.deepEqual(store.status(key).drafts, []);
  const final = await store.waitForFeedback(key, 5000);
  assert.equal(final.status, "feedback");
  assert.equal(final.prompts[0].prompt, "last");
  assert.equal(final.session_ended, true);
  assert.equal(final.ended_by, "user");
  // Acknowledging the final batch clears it, so the next poll sees only the ended notice.
  assert.deepEqual(
    await store.waitForFeedback(key, 5000, undefined, cursor(store, key, final.receipt)),
    {
      status: "ended",
      ended_by: "user",
    },
  );
  assert.equal(store.presence(key).state, "waiting", "an ended session has no working agent");
  assert.equal(new SessionStore(dir).status(key).ended.by, "user");

  store.reopen(key);
  assert.equal(store.status(key).ended, null);
  const waiting = store.waitForFeedback(key, 5000);
  store.end(key, "agent");
  assert.deepEqual(await waiting, { status: "ended", ended_by: "agent" });
});

test("ending while the agent is working says so, so no tab is left holding a disabled Send", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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

test("the agent stops working once it has replied to every note it took, and not before", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  store.queue(key, [prompt("one")]);
  await store.waitForFeedback(key, 5000);
  store.reply(key, 1, { status: "done" });
  // A note sent while it worked on the first is not part of what it took.
  store.queue(key, [prompt("two"), prompt("three")]);
  await store.waitForFeedback(key, 5000, undefined, cursor(store, key, 1));
  assert.equal(store.presence(key).state, "working");
  const seen = [];
  store.on(key, (event) => event.type === "presence" && seen.push(event.state));
  store.reply(key, 1, { status: "declined", message: "Not this one after all" });
  store.reply(key, 2, { status: "done" });
  assert.equal(store.presence(key).state, "working", "one note it took is still unanswered");
  assert.deepEqual(seen, []);
  store.reply(key, 3, { status: "question", message: "Which week?" });
  assert.deepEqual(store.presence(key), { state: "waiting" });
  assert.deepEqual(seen, ["waiting"], "the tab is told the agent is no longer working");
});

test("a file that goes ends the agent's working state, and tells the tab", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  store.queue(key, [prompt()]);
  await store.waitForFeedback(key, 5000);
  assert.equal(store.presence(key).state, "working");
  const seen = [];
  store.on(key, (event) => seen.push(event.type === "presence" ? event.state : event.type));
  renameSync(artifact, `${artifact}.away`);
  store.fileChanged(key);
  assert.deepEqual(store.presence(key), { state: "waiting" });
  assert.deepEqual(seen, ["gone", "waiting"]);
  assert.deepEqual(store.status(key).presence, { state: "waiting" }, "a tab's hello agrees");
});

test("an agent end never relabels a review the reviewer ended", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  store.end(key, "user");
  assert.deepEqual(store.end(key, "agent"), { status: "ended", ended_by: "user", queued: 0 });
  assert.equal(store.status(key).ended.by, "user");
  assert.equal(new SessionStore(dir).status(key).ended.by, "user");
});

test("each note keeps the time it was written, and an unusable stamp falls back to arrival", async () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  const written = new Date().toISOString();
  // Not a wait for anything: it puts the clock past `written`, so an arrival stamp differs from it.
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
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
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

test("a reply lands on its note, survives a restart, reaches every tab, and is validated", () => {
  const { dir, artifact } = lab();
  const store = new SessionStore(dir);
  const { key } = store.open(artifact);
  store.queue(key, [prompt("one"), prompt("two")]);
  const heard = [];
  store.on(key, (event) => heard.push(event));

  const answered = store.reply(key, 2, { status: "declined", message: "<b>Out</b> of scope" });
  assert.equal(answered.status, "replied");
  assert.deepEqual(heard, [{ type: "reply", uid: 2, reply: answered.reply }]);
  assert.equal(store.bootstrap(key).chat[1].reply.message, "<b>Out</b> of scope");
  assert.equal(store.status(key).chat[1].reply.status, "declined", "a tab's hello carries it");
  assert.equal(new SessionStore(dir).get(key).chat[1].reply.status, "declined");
  // A message of nothing but space says nothing, so it is not kept.
  assert.deepEqual(Object.keys(store.reply(key, 1, { status: "done", message: "  " }).reply), [
    "status",
    "at",
  ]);

  const refused = (uid, body, status, pattern) =>
    assert.throws(
      () => store.reply(key, uid, body),
      (e) => e.status === status && pattern.test(e.message),
    );
  refused(3, { status: "done" }, 404, /no note 3/);
  refused("1", { status: "done" }, 400, /positive integer/);
  refused(1, { status: "resolved" }, 400, /done, declined, question/);
  refused(1, null, 400, /must be an object/);
  refused(1, { status: "question", message: " " }, 400, /needs its text/);
  refused(1, { status: "done", message: 7 }, 400, /must be a string/);
  refused(1, { status: "done", message: "x".repeat(limits.replyChars + 1) }, 400, /over 2000/);
  assert.throws(
    () => store.addDraft(key, { ...prompt(), answers: 1.5 }),
    (e) => e.status === 400 && /a note's uid/.test(e.message),
  );
});
