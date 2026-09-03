import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "../src/server.js";
import { fixture } from "./helpers/env.js";

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
  assert.equal(statSync(join(dir, "server.json")).mode & 0o777, 0o600);
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
    { prompts: [{ prompt: "Shorter", selector: "#title", tag: "h1", text: "Rollout plan" }] },
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
  const chat = (await get(`/api/${key}/session`)).chat;
  assert.equal(chat.length, 1);
  assert.equal(chat[0].prompt, "Shorter");
  assert.deepEqual(await get(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=10`), {
    status: "waiting",
  });
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

test("an idle server stops itself", async () => {
  let idled = false;
  const short = await serve({
    stateDir: mkdtempSync(join(tmpdir(), "pb-idle-")),
    idleMs: 60,
    onIdle: () => (idled = true),
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(idled, true);
  await assert.rejects(fetch(`http://127.0.0.1:${short.port}/health`));
});
