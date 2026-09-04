import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { limits } from "../src/limits.js";
import { serve } from "../src/server.js";
import { fixture } from "./helpers/env.js";
import { until } from "./helpers/wait.js";
import { assertPrivate } from "./helpers/private.js";
import { watchAvailable } from "./helpers/watch.js";

let dir, srv, base, headers, key, artifactUrl;

before(async () => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-server-"));
  srv = await serve({ stateDir: dir, port: 0, idleMs: 60_000 });
  base = `http://127.0.0.1:${srv.port}`;
  headers = { authorization: `Bearer ${srv.token}`, "content-type": "application/json" };
  const opened = await post("/api/sessions", { file: fixture });
  key = opened.key;
  artifactUrl = (await get(`/api/${key}/session`)).artifactUrl;
});
after(() => srv.close());

const get = (path, extra = {}) =>
  fetch(base + path, { headers: { ...headers, ...extra } }).then((r) => r.json());
const post = (path, body, extra = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const status = (path, init = {}) => fetch(base + path, init).then((r) => r.status);

/** Sends a request line verbatim, so dot segments reach the server instead of being squashed by fetch. */
function raw(requestPath) {
  return rawWithHost(requestPath, `127.0.0.1:${srv.port}`);
}

function rawWithHost(requestPath, host) {
  return new Promise((resolve) => {
    const socket = connect(srv.port, "127.0.0.1", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (d) => (text += d));
    socket.on("close", () => resolve(text));
  });
}

test("server.json records the process, port and token, owner-only", () => {
  const info = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, srv.port);
  assert.equal(info.token, srv.token);
  assertPrivate(join(dir, "server.json"), 0o600);
});

test("health is open; every api route needs the token", async () => {
  assert.equal((await fetch(`${base}/health`).then((r) => r.json())).ok, true);
  assert.equal(await status(`/api/${key}/session`), 401);
  assert.equal(
    await status(`/api/${key}/session`, { headers: { authorization: "Bearer nope" } }),
    401,
  );
  assert.equal(await status("/api/sessions", { method: "POST" }), 401);
  assert.equal(await status(`/api/poll?file=${encodeURIComponent(fixture)}`), 401);
});

test("host and origin are checked on the way in", async () => {
  assert.match(await rawWithHost("/health", "evil.com"), /^HTTP\/1\.1 403/);
  assert.match(await rawWithHost("/health", `127.0.0.1:${srv.port + 1}`), /^HTTP\/1\.1 403/);
  assert.match(await rawWithHost("/health", `localhost:${srv.port}`), /^HTTP\/1\.1 200/);
  assert.equal(
    await status(`/api/${key}/prompts`, {
      method: "POST",
      headers: { ...headers, origin: "http://evil.com" },
    }),
    403,
  );
  assert.equal(
    await status(`/api/${key}/prompts`, {
      method: "POST",
      headers: { ...headers, origin: "null" },
    }),
    403,
  );
});

test("the chrome page carries a locked-down policy and cannot be framed", async () => {
  const res = await fetch(`${base}/session/${key}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const html = await res.text();
  assert.ok(!html.includes(srv.token), "the chrome page must not embed the token");
  assert.equal(await status("/session/0000000000000000"), 404);
  assert.equal(await status("/session/__proto__"), 404);
});

test("the chrome page names a tab icon, and both forms of it are served as images", async () => {
  const html = await fetch(`${base}/session/${key}`).then((r) => r.text());
  assert.match(html, /<link rel="icon" href="\/icon\.svg" sizes="any" type="image\/svg\+xml" \/>/);
  assert.match(html, /<link rel="icon" href="\/icon-32\.png" sizes="32x32" type="image\/png" \/>/);
  const svg = await fetch(`${base}/icon.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(await svg.text(), /prefers-color-scheme: dark/, "the icon follows the tab strip");
  const png = await fetch(`${base}/icon-32.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(
    Buffer.from(await png.arrayBuffer())
      .subarray(1, 4)
      .toString(),
    "PNG",
  );
  assert.equal(await status("/__proto__"), 404);
});

test("the artifact is served injected and sandboxed, its siblings confined, its token required", async () => {
  const res = await fetch(base + artifactUrl);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("content-security-policy"),
    "sandbox allow-scripts allow-forms allow-popups",
  );
  assert.equal(res.headers.get("cross-origin-resource-policy"), null);
  const html = await res.text();
  assert.match(html, /<script src="\/sdk.js"><\/script><\/body>/);
  assert.equal(await status(`${dirname(artifactUrl)}/plan.css`), 200);
  assert.equal(await status(`${dirname(artifactUrl)}/missing.css`), 404);
  const wrongToken = artifactUrl.replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`);
  assert.equal(await status(wrongToken), 404);
  assert.equal(await status(`/artifact/${key}/short/plan.html`), 404);
});

test("traversal over the wire is refused, dot segments and encodings included", async () => {
  const outside = join(dirname(fixture), "..", "..", "package.json");
  assert.ok(statSync(outside).isFile());
  const escape = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-esc-")), "escape.html");
  writeFileSync(escape, "<p></p>");
  symlinkSync("/etc/hosts", join(dirname(escape), "hosts"));
  const opened = await post("/api/sessions", { file: escape });
  const url = (await get(`/api/${opened.key}/session`)).artifactUrl;
  for (const path of [
    `${dirname(artifactUrl)}/../../../../package.json`,
    `${dirname(artifactUrl)}/..%2f..%2f..%2f..%2fpackage.json`,
    `${dirname(artifactUrl)}/%2e%2e/%2e%2e/package.json`,
    `${dirname(artifactUrl)}//etc/hosts`,
    `${dirname(artifactUrl)}/plan.css%00`,
    `${dirname(url)}/hosts`,
  ]) {
    const reply = await raw(path);
    assert.match(reply, /^HTTP\/1\.1 404/, path);
    assert.ok(
      !reply.includes('"name"') && !reply.includes("localhost"),
      `leaked content for ${path}`,
    );
  }
});

test("prompts queue, show in the chat, and reach one poller with anchors intact", async () => {
  const waiting = get(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=5000`);
  await new Promise((r) => setTimeout(r, 50));
  const queued = await post(
    `/api/${key}/prompts`,
    {
      prompts: [{ prompt: "Shorter", selector: "#title", tag: "h1", text: "Rollout plan" }],
      structure: 'main\n  #title "Rollout plan"',
    },
    { origin: base },
  );
  assert.equal(queued.status, "queued");
  const result = await waiting;
  assert.equal(result.status, "feedback");
  assert.deepEqual(
    result.prompts.map(({ uid, prompt, selector, tag, text }) => ({
      uid,
      prompt,
      selector,
      tag,
      text,
    })),
    [{ uid: 1, prompt: "Shorter", selector: "#title", tag: "h1", text: "Rollout plan" }],
  );
  assert.equal(result.structure, 'main\n  #title "Rollout plan"');
  const chat = (await get(`/api/${key}/session`)).chat;
  assert.equal(chat.length, 1);
  assert.equal(chat[0].prompt, "Shorter");
  // Acknowledging the batch (its high uid) clears it, so the next poll waits instead of redelivering.
  assert.deepEqual(
    await get(
      `/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=10&ack=${result.prompts[0].uid}`,
    ),
    { status: "waiting" },
  );
});

test("bad input on the api is a 4xx, not a crash", async () => {
  assert.equal(await status("/api/sessions", { method: "POST", headers, body: "[]" }), 400);
  assert.equal(
    await status("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ file: "/nope" }),
    }),
    404,
  );
  assert.equal(await status("/api/poll", { headers }), 400);
  assert.equal(
    await status(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=-1`, { headers }),
    400,
  );
  assert.equal(await status(`/api/${key}/prompts`, { method: "POST", headers, body: "{" }), 400);
  assert.equal(
    await status(`/api/${key}/prompts`, { method: "POST", headers, body: JSON.stringify({}) }),
    400,
  );
  assert.equal(
    await status(`/api/__proto__/prompts`, { method: "POST", headers, body: "{}" }),
    404,
  );
  assert.equal(await status(`/api/${key}/nothing`, { headers }), 404);
  assert.equal(await status(`/api/${key}/session`, { method: "DELETE", headers }), 405);
  assert.equal(await status("/nothing"), 404);
  assert.equal(
    await status(`/api/${key}/prompts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pad: "x".repeat(300_000) }),
    }),
    413,
  );
  assert.equal(Object.prototype.status, undefined);
});

/** Opens an event stream and yields one parsed line at a time, so a test can await an event. */
async function eventStream(path) {
  const controller = new AbortController();
  const res = await fetch(base + path, { headers, signal: controller.signal });
  if (!res.ok) {
    controller.abort();
    return { status: res.status, close: () => {} };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    async next() {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line !== "") return JSON.parse(line);
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    /**
     * Reads until an event of `type` arrives and returns the ones that preceded it, so the
     * caller asserts about the event it named instead of whichever line happened to be next.
     * The deadline is not patience for a slow machine - supersession is written during the
     * request that causes it - it is what turns a broken supersession into a named failure
     * rather than a 60-second suite timeout.
     */
    async until(type, timeoutMs = 10_000) {
      const before = [];
      const expired = Symbol("expired");
      const deadline = new Promise((resolve) => setTimeout(resolve, timeoutMs, expired).unref());
      for (;;) {
        const event = await Promise.race([this.next(), deadline]);
        const seen = JSON.stringify(before.map((e) => e.type));
        if (event === expired) assert.fail(`no ${type} event within ${timeoutMs} ms; saw ${seen}`);
        if (event === null) assert.fail(`the stream ended before any ${type} event; saw ${seen}`);
        if (event.type === type) return before;
        before.push(event);
      }
    },
    close: () => controller.abort(),
  };
}

test("the event stream greets a tab, supersedes the older one and is capped", async (t) => {
  // Supersession is asserted on both paths, because it has nothing to do with file watching.
  // What the probe decides is only whether a `reload-off` may share the stream with it.
  const watching = await watchAvailable();
  const permitted = watching ? [] : ["reload-off"];
  t.diagnostic(
    watching
      ? "file watching works here: supersession must reach the older tab alone"
      : "file watching is unavailable here: supersession must reach the older tab past a reload-off",
  );
  const opened = await post("/api/sessions", { file: fixture });
  const first = await eventStream(`/api/${opened.key}/events`);
  assert.equal(first.contentType, "application/x-ndjson; charset=utf-8");
  assert.deepEqual(await first.next(), {
    type: "hello",
    revision: 0,
    presence: { state: "waiting" },
    ended: null,
  });
  const second = await eventStream(`/api/${opened.key}/events`);
  assert.equal((await second.next()).type, "hello");
  const before = await first.until("superseded");
  assert.deepEqual(
    before.map((event) => event.type).filter((type) => !permitted.includes(type)),
    [],
    `only ${JSON.stringify(permitted)} may precede supersession on this machine`,
  );

  const rest = [];
  while (rest.length + 2 < limits.eventStreams) {
    rest.push(await eventStream(`/api/${opened.key}/events`));
  }
  const overflow = await eventStream(`/api/${opened.key}/events`);
  assert.equal(overflow.status, 429, `the ${limits.eventStreams + 1}th stream is refused`);
  for (const stream of [first, second, ...rest]) stream.close();
  assert.equal(await status(`/api/0000000000000000/events`, { headers }), 404);
});

test("a poll whose connection dies before the reply redelivers the batch, never loses it", async () => {
  const file = join(dir, "redeliver.html");
  writeFileSync(file, "<p>x</p>");
  const k = (await post("/api/sessions", { file })).key;
  await post(
    `/api/${k}/prompts`,
    { prompts: [{ prompt: "do not lose me", selector: "#p", tag: "p", text: "x" }] },
    { origin: base },
  );
  // The poll sends its request and drops the socket before reading the reply, so the batch is taken
  // from the queue but its response never arrives - the exact shape of the silent loss this fixes.
  await new Promise((resolve) => {
    const socket = connect(srv.port, "127.0.0.1", () => {
      socket.write(
        `GET /api/poll?file=${encodeURIComponent(file)}&timeoutMs=0 HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nAuthorization: Bearer ${srv.token}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 150));
  const again = await get(`/api/poll?file=${encodeURIComponent(file)}&timeoutMs=1000`);
  assert.equal(again.status, "feedback");
  assert.equal(again.prompts[0].prompt, "do not lose me");
  assert.equal(again.prompts[0].uid, 1, "the redelivered note keeps its uid");
});

test("the reviewer ends the review with the queue attached, and only a reopen revives it", async () => {
  const opened = await post("/api/sessions", { file: fixture });
  const ended = await post(
    `/api/${opened.key}/end`,
    {
      by: "user",
      prompts: [{ prompt: "One last thing", selector: "#title", tag: "h1", text: "Rollout" }],
    },
    { origin: base },
  );
  assert.deepEqual(ended, { status: "ended", ended_by: "user", queued: 1 });
  const last = await get(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=1000`);
  assert.equal(last.status, "feedback");
  assert.equal(last.session_ended, true);
  assert.equal(last.prompts[0].prompt, "One last thing");
  assert.deepEqual(
    await get(
      `/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=1000&ack=${last.prompts[0].uid}`,
    ),
    { status: "ended", ended_by: "user" },
  );
  assert.equal((await post("/api/sessions", { file: fixture })).status, "user-ended");
  assert.equal((await post("/api/sessions", { file: fixture, reopen: true })).status, "opened");
  assert.equal((await get(`/api/${opened.key}/session`)).ended, null);

  // An agent that ended its own review needs no ceremony to come back.
  await post(`/api/${opened.key}/end`, { by: "agent" }, { origin: base });
  assert.equal((await post("/api/sessions", { file: fixture })).status, "opened");
  assert.equal(
    await status(`/api/${opened.key}/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({ by: "nobody" }),
    }),
    400,
  );
});

test("the daemon idles on inactivity; a heartbeat keeps it alive, an open but silent tab does not", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Asked of the long-lived server at the top of this file, not of a short-idle one. A daemon
  // with a 60 ms window is not something a test can reliably ask a question inside, and asking
  // is itself the activity that resets it: on run 33875622583, attempt 4, this very request
  // came back `connect ECONNREFUSED` because windows-2025 took longer than the window to get
  // round to it.
  assert.equal(
    (await get("/health")).idleMs,
    60_000,
    "the daemon reports its idle window so the tab can pace its heartbeat",
  );

  // With no activity at all, the daemon idles out and stops answering. Nothing touches it
  // before it does, so there is no window here for a runner to starve this out of.
  let idled = false;
  const short = await serve({
    stateDir: mkdtempSync(join(tmpdir(), "pb-idle-")),
    idleMs: 60,
    onIdle: () => (idled = true),
  });
  await until(() => idled, { what: "the untouched daemon to idle out", timeoutMs: 10_000 });
  await assert.rejects(fetch(`http://127.0.0.1:${short.port}/health`));

  // A stream stays open the whole time, but only the heartbeat keeps the daemon alive: when the
  // heartbeat stops, the daemon releases even though the tab is still connected - an abandoned tab
  // does not pin the process open, which a stream-keeps-it-alive rule would have let it do.
  let released = false;
  const idleMs = 150;
  const held = await serve({
    stateDir: mkdtempSync(join(tmpdir(), "pb-held-")),
    idleMs,
    onIdle: () => (released = true),
  });
  // The beat starts in the same turn the server was created in and runs back to back with no
  // sleep in it, so nothing below - not the session setup, not the runner descheduling this
  // process - can open a gap wider than one loopback round trip. The loop this replaces slept
  // 80 ms between beats against this 150 ms window and needed the setup to fit inside another,
  // and when windows-2025 granted neither the daemon idled out mid-test and the next request
  // came back `TypeError: fetch failed, connect ECONNREFUSED` - a crash where an assertion was
  // meant to be. Measuring the gap is what makes a starved runner say so instead.
  let beating = true;
  let beats = 0;
  let lost = null;
  const heartbeat = (async () => {
    let lastAt = Date.now();
    while (beating) {
      try {
        await fetch(`http://127.0.0.1:${held.port}/health`);
      } catch {
        lost = { afterBeats: beats, gapMs: Date.now() - lastAt };
        return;
      }
      lastAt = Date.now();
      beats += 1;
    }
  })();

  const info = { authorization: `Bearer ${held.token}`, "content-type": "application/json" };
  const session = await fetch(`http://127.0.0.1:${held.port}/api/sessions`, {
    method: "POST",
    headers: info,
    body: JSON.stringify({ file: fixture }),
  }).then((r) => r.json());
  const watching = new AbortController();
  await fetch(`http://127.0.0.1:${held.port}/api/${session.key}/events`, {
    headers: info,
    signal: watching.signal,
  });
  await sleep(idleMs * 4);
  beating = false;
  await heartbeat;
  assert.equal(
    lost,
    null,
    lost &&
      `the daemon stopped answering after ${lost.afterBeats} heartbeats, ${lost.gapMs} ms after ` +
        `the last one, against a ${idleMs} ms idle window: the runner starved this loop rather ` +
        `than a heartbeat failing to count as activity`,
  );
  assert.equal(released, false, "a heartbeat inside the idle window keeps it alive");
  assert.ok(beats > 4, `only ${beats} heartbeats fitted four ${idleMs} ms idle windows`);

  // And with the heartbeat stopped, the daemon releases even though the stream is still open.
  await until(() => released, {
    what: "an open but no-longer-heartbeating tab to let the daemon idle out",
    timeoutMs: 10_000,
  });
  watching.abort();
  await held.close();
});
