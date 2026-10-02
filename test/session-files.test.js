import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { serve } from "../src/server.js";
import { EPOCH_PATTERN, SessionStore } from "../src/session-store.js";

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-files-"));
const sessionFile = (stateDir, key) => join(stateDir, "sessions", `${key}.json`);
const note = (prompt, extra = {}) => ({ prompt, selector: "h1", tag: "h1", text: "x", ...extra });

/** A daemon on `stateDir`, and a JSON call to it that survives the pool's stale connection. */
async function daemonAt(stateDir) {
  const daemon = await serve({ stateDir, port: 0, idleMs: 60_000 });
  const once = (method, path, body) =>
    fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  // fetch may hand the first request after a restart a connection the old daemon closed.
  const call = (method, path, body) =>
    once(method, path, body).catch(() => once(method, path, body));
  return { close: () => daemon.close(), call };
}

/** What a tab is shown on connecting, less presence, which describes live connections only. */
async function shown(call, key) {
  const { status, body } = await call("GET", `/api/${key}/session`);
  assert.equal(status, 200, `session ${key}: ${JSON.stringify(body)}`);
  delete body.presence;
  return body;
}

function artifacts(dir, names) {
  return names.map((name) => {
    const file = join(dir, name);
    writeFileSync(file, `<h1>${name}</h1>`);
    return file;
  });
}

// Both fixtures were written by the real code of their version, not by hand: 0.1.4 as released,
// and the last build before this split, which added drafts, replies, epochs and asset roots. Only
// each random asset token was then swapped for repeated digits, which a secret scanner passes.
for (const [name, made] of [
  ["state-0.1.4.json", "0.1.4"],
  ["state-pre-split.json", "the last single-file build"],
]) {
  test(`a state.json from ${made} is split into a file per session, every field intact`, async () => {
    const stateDir = scratch();
    const original = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    writeFileSync(join(stateDir, "state.json"), original);
    const stored = JSON.parse(original).sessions;
    const keys = Object.keys(stored);
    assert.ok(keys.length >= 3, "the fixture holds several sessions");

    let daemon = await daemonAt(stateDir);
    const first = {};
    try {
      for (const key of keys) {
        const was = stored[key];
        first[key] = await shown(daemon.call, key);
        assert.deepEqual(first[key].chat, was.chat, `${key}: every note, with its reply`);
        assert.deepEqual(first[key].drafts, was.drafts ?? [], `${key}: every unsent note`);
        assert.equal(first[key].revision, was.revision);
        assert.deepEqual(
          first[key].ended,
          was.endedAt ? { by: was.endedBy, at: was.endedAt } : null,
        );
      }
    } finally {
      await daemon.close();
    }

    assert.equal(existsSync(join(stateDir, "state.json")), false, "the old file is not read again");
    assert.equal(
      readFileSync(join(stateDir, "state.json.migrated"), "utf8"),
      original,
      "and it is kept, renamed and unchanged",
    );
    const split = {};
    for (const key of keys) {
      split[key] = readFileSync(sessionFile(stateDir, key), "utf8");
      const { epoch, root, ...held } = JSON.parse(split[key]);
      const { epoch: wasEpoch, root: wasRoot, ...had } = stored[key];
      assert.deepEqual(held, had, `${key}: every field the old file held, ack state included`);
      // 0.1.4 recorded neither; the split gives each session the one a later version would have.
      assert.equal(epoch, wasEpoch ?? epoch);
      assert.match(epoch, EPOCH_PATTERN);
      assert.equal(root, wasRoot ?? dirname(stored[key].file));
    }

    // A restart reads the split files and changes nothing in them, the epochs included.
    daemon = await daemonAt(stateDir);
    try {
      for (const key of keys) assert.deepEqual(await shown(daemon.call, key), first[key]);
    } finally {
      await daemon.close();
    }
    for (const key of keys)
      assert.equal(readFileSync(sessionFile(stateDir, key), "utf8"), split[key], key);

    // The batch the agent was handed and never acknowledged comes back unchanged, under the epoch
    // it now carries, and a cursor naming that epoch releases the next one. By key rather than by
    // the fixture's path, which names a file that need not exist on this machine.
    const [held] = keys.filter((key) => stored[key].unacked);
    const store = new SessionStore(stateDir);
    const epoch = store.get(held).epoch;
    const again = await store.waitForFeedback(held, 0);
    assert.deepEqual(
      [again.prompts, again.receipt, again.epoch],
      [stored[held].unacked.prompts, stored[held].unacked.receipt, epoch],
    );
    const next = await store.waitForFeedback(held, 0, undefined, { uid: again.receipt, epoch });
    assert.deepEqual(next.prompts, stored[held].pending);
  });
}

test("a restart restores every session, with its drafts, replies and outstanding batch", async () => {
  const stateDir = scratch();
  const [asked, ended, drafted] = artifacts(stateDir, ["asked.html", "ended.html", "drafted.html"]);
  let daemon = await daemonAt(stateDir);
  const before = {};
  let delivered;
  try {
    const { call } = daemon;
    const open = async (file) => (await call("POST", "/api/sessions", { file })).body.key;
    const send = async (key, ...prompts) => {
      for (const prompt of prompts)
        await call("POST", `/api/${key}/drafts`, { draft: note(prompt) });
      await call("POST", `/api/${key}/prompts`, {});
    };
    const poll = async (file, cursor = "") =>
      (await call("GET", `/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0${cursor}`)).body;

    const a = await open(asked);
    await send(a, "Shorter title", "Who owns this?");
    delivered = await poll(asked);
    await call("POST", `/api/${a}/replies`, { uid: 1, status: "done", message: "Shortened." });
    await call("POST", `/api/${a}/replies`, { uid: 2, status: "question", message: "Which team?" });
    await call("POST", `/api/${a}/drafts`, { draft: note("Product", { answers: 2 }) });

    const b = await open(ended);
    await send(b, "Drop the footer");
    const taken = await poll(ended);
    await poll(ended, `&ack=${taken.receipt}&epoch=${taken.epoch}`);
    await call("POST", `/api/${b}/replies`, { uid: 1, status: "declined", message: "Legal." });
    await call("POST", `/api/${b}/end`, { by: "user" });

    const c = await open(drafted);
    await call("POST", `/api/${c}/drafts`, { draft: note("First thought") });
    await call("POST", `/api/${c}/drafts`, { draft: note("Second thought") });

    for (const key of [a, b, c]) before[key] = await shown(call, key);
    assert.equal(before[a].chat[1].reply.status, "question", "the setup took");
    assert.equal(before[b].ended.by, "user", "the setup took");
  } finally {
    await daemon.close();
  }

  daemon = await daemonAt(stateDir);
  try {
    for (const [key, was] of Object.entries(before))
      assert.deepEqual(await shown(daemon.call, key), was, key);
    const again = await daemon.call(
      "GET",
      `/api/poll?file=${encodeURIComponent(asked)}&timeoutMs=0`,
    );
    assert.deepEqual(again.body, delivered, "the unacknowledged batch is redelivered as it was");
  } finally {
    await daemon.close();
  }
});

test("a write killed between its temp file and its rename leaves every session whole, and no litter", async () => {
  const stateDir = scratch();
  const files = artifacts(stateDir, ["first.html", "second.html"]);
  const helper = fileURLToPath(new URL("./helpers/crash-mid-write.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [helper, stateDir, ...files], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.match(
    child.stdout,
    /^killed before \.[0-9a-f]+\.tmp replaced [^\n]+\.json$/m,
    `the child was not killed inside a state write: ${child.stdout} ${child.stderr}`,
  );

  const daemon = await daemonAt(stateDir);
  try {
    for (const file of files) {
      const { key } = (await daemon.call("POST", "/api/sessions", { file })).body;
      assert.deepEqual(
        (await shown(daemon.call, key)).drafts.map((d) => d.prompt),
        [`kept on ${basename(file)}`],
        `${basename(file)} reads as it was before the interrupted write`,
      );
    }
  } finally {
    await daemon.close();
  }
  // The temp file is as large as what it was replacing, so one left per crash is real disk.
  const litter = readdirSync(stateDir, { recursive: true }).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(litter, [], "the interrupted write left nothing behind");
});

test("damage to one session's stored state costs that session, never the others", async () => {
  const stateDir = scratch();
  const [kept, damaged] = artifacts(stateDir, ["kept.html", "damaged.html"]);
  let daemon = await daemonAt(stateDir);
  const keys = [];
  try {
    for (const file of [kept, damaged]) {
      const { key } = (await daemon.call("POST", "/api/sessions", { file })).body;
      await daemon.call("POST", `/api/${key}/drafts`, { draft: note(`on ${basename(file)}`) });
      keys.push(key);
    }
  } finally {
    await daemon.close();
  }
  // Whichever file holds the damaged session is cut short, as a full disk or a bad sector would.
  const holders = readdirSync(stateDir, { recursive: true })
    .map((name) => join(stateDir, String(name)))
    .filter((path) => path.endsWith(".json") && statSync(path).isFile())
    .filter((path) => readFileSync(path, "utf8").includes(`"key": "${keys[1]}"`));
  assert.ok(holders.length > 0, "found where the damaged session is kept");
  for (const path of holders) truncateSync(path, Math.floor(statSync(path).size / 2));

  daemon = await daemonAt(stateDir);
  try {
    assert.deepEqual(
      (await shown(daemon.call, keys[0])).drafts.map((d) => d.prompt),
      ["on kept.html"],
      "the undamaged session is untouched",
    );
    assert.equal((await daemon.call("GET", `/api/${keys[1]}/session`)).status, 404);
  } finally {
    await daemon.close();
  }
});
