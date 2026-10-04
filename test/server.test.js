import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { limits } from "../src/limits.js";
import { SessionStore } from "../src/session-store.js";
import { serve } from "../src/server.js";
import { tokenProof } from "../src/http-guard.js";
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

/** Queues notes the way the chrome does: each one kept as a draft, then Send. */
async function queueNotes(k, prompts, structure) {
  for (const draft of prompts)
    await post(`/api/${k}/drafts`, { draft, structure }, { origin: base });
  return post(`/api/${k}/prompts`, {}, { origin: base });
}

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

test("the wrapper frame is served for the chrome under the other loopback name, and nothing else", async () => {
  const chrome = await fetch(`${base}/session/${key}`);
  const wrapperAt = `http://localhost:${srv.port}`;
  assert.match(
    chrome.headers.get("content-security-policy"),
    new RegExp(`frame-src ${wrapperAt};`),
  );
  const res = await fetch(`${base}/wrapper.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  // Asked for under 127.0.0.1, so it answers for a chrome under localhost.
  assert.match(
    res.headers.get("content-security-policy"),
    new RegExp(`frame-ancestors ${wrapperAt}$`),
  );
  assert.match(await res.text(), /<script src="\/wrapper\.js"><\/script>/);
  assert.equal(await status("/wrapper.html", { method: "POST" }), 404);
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
  // A page the frame can land on, so it answers as a page: a sentence in the house's styles, still
  // sandboxed, never the JSON an API caller gets.
  const missing = await fetch(`${base}${dirname(artifactUrl)}/plan-v2.html`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    missing.headers.get("content-security-policy"),
    "sandbox allow-scripts allow-forms allow-popups",
  );
  const page = await missing.text();
  assert.match(page, /<p[^>]*>There is no file at this address in the review\.<\/p>/);
  assert.match(page, /<link rel="stylesheet" href="\/house\/roles\.css" \/>/);
  assert.doesNotMatch(page, /"error"/);
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

/**
 * A design system's layout: a sheet two folders down that links `../components.css` and
 * `../../exports/variables.css`, a secret beside the repository, and two symlinks inside the
 * repository that lead out to it. The repository is also reachable through a symlinked alias.
 */
function repoLab() {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-root-"));
  const repo = join(base, "repo");
  const sheets = join(repo, "components", "sheets");
  mkdirSync(sheets, { recursive: true });
  mkdirSync(join(repo, "exports"));
  const sheet = join(sheets, "actions.html");
  writeFileSync(sheet, '<link rel="stylesheet" href="../components.css"><p>sheet</p>');
  writeFileSync(join(repo, "components", "components.css"), ".button{}");
  writeFileSync(join(repo, "exports", "variables.css"), ":root{--hw-ink:#111}");
  writeFileSync(join(base, "secret.txt"), "SECRET");
  symlinkSync(join(base, "secret.txt"), join(sheets, "leak.css"));
  symlinkSync(base, join(repo, "up"));
  symlinkSync(repo, join(base, "alias"));
  return { base, repo, sheet };
}

/** What a browser fetches for `href` written in the page at `pageUrl`: dot segments resolved first. */
const linked = (pageUrl, href) => new URL(href, base + pageUrl).pathname;

test("assets outside the file's folder load only from a named root, which holds the file", async () => {
  const { base: outside, repo, sheet } = repoLab();
  const opened = await post("/api/sessions", { file: sheet });
  const plain = (await get(`/api/${opened.key}/session`)).artifactUrl;
  assert.match(plain, /\/actions\.html$/, "without a root the page sits at its folder's top");
  assert.equal(await status(linked(plain, "../components.css")), 404, "today's default is kept");

  // Named through a symlinked alias, the root is stored by its canonical spelling.
  const widened = await post("/api/sessions", { file: sheet, root: join(outside, "alias") });
  assert.equal(widened.key, opened.key, "a root is a setting of the review, not another review");
  const page = (await get(`/api/${opened.key}/session`)).artifactUrl;
  assert.match(page, /\/components\/sheets\/actions\.html$/);
  for (const [href, body] of [
    ["../components.css", ".button{}"],
    ["../../exports/variables.css", ":root{--hw-ink:#111}"],
  ]) {
    const res = await fetch(base + linked(page, href));
    assert.equal(res.status, 200, href);
    assert.equal(await res.text(), body, href);
  }
  const html = await fetch(base + page).then((r) => r.text());
  assert.match(html, /<script src="\/sdk.js"><\/script>/, "the page itself is still injected");

  // Out of the root: by dot segments the browser resolves, by ones it sends raw, by encodings,
  // and by a symlink inside the root whose target is outside it.
  const top = dirname(dirname(dirname(page)));
  for (const path of [
    linked(page, "../../../secret.txt"),
    `${top}/../secret.txt`,
    `${top}/..%2fsecret.txt`,
    `${top}/%2e%2e/secret.txt`,
    `${top}/components/sheets/leak.css`,
    `${top}/up/secret.txt`,
  ]) {
    const reply = await raw(path);
    assert.match(reply, /^HTTP\/1\.1 404/, path);
    assert.ok(!reply.includes("SECRET"), `leaked the secret for ${path}`);
  }

  // A root that does not hold the file, is not a folder, or does not exist is refused at open.
  const refused = async (root) =>
    fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file: sheet, root }),
    }).then(async (r) => [r.status, (await r.json()).error]);
  assert.deepEqual(await refused(join(repo, "exports")), [
    400,
    `${realpathSync.native(sheet)} is not inside root ${realpathSync.native(join(repo, "exports"))}`,
  ]);
  assert.equal((await refused(sheet))[0], 400, "a file is not a root");
  assert.equal((await refused(join(repo, "nope")))[0], 404);
  assert.equal((await refused(""))[0], 400);
  assert.equal((await refused(7))[0], 400);

  // Opening again without a root goes back to the file's own folder.
  await post("/api/sessions", { file: sheet });
  const again = (await get(`/api/${opened.key}/session`)).artifactUrl;
  assert.equal(again, plain);
  assert.equal(await status(linked(again, "../components.css")), 404);
});

// The artifact frame is opaque-origin, so every asset load from it is cross-origin. Only a font may be
// read that way: CORS on any other file would let a hostile page read it and send it out.
test("only a font is readable cross-origin, never the page, another file or the api", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-font-"));
  const site = join(root, "site");
  mkdirSync(join(site, "fonts"), { recursive: true });
  const fonts = ["a.woff2", "a.woff", "a.ttf", "a.otf", "B.WOFF2"];
  const others = ["page.css", "app.js", "data.json", ".env", "logo.png", "logo.svg", "notes.txt"];
  for (const name of [...fonts, ...others]) writeFileSync(join(site, "fonts", name), "x");
  writeFileSync(join(root, "outside.woff2"), "x");
  symlinkSync(join(root, "outside.woff2"), join(site, "fonts", "link.woff2"));
  // A file named like a font is not a page, and the page is never readable cross-origin.
  writeFileSync(join(site, "page.woff2"), "<p>a page with a font's name</p>");
  const named = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ file: join(site, "page.woff2") }),
  });
  assert.equal(named.status, 415);
  const page = join(site, "page.html");
  writeFileSync(page, "<p>a page</p>");
  const opened = await post("/api/sessions", { file: page });
  const url = (await get(`/api/${opened.key}/session`)).artifactUrl;
  const corsOf = async (path) => {
    const res = await fetch(base + path, { headers: { origin: "null" } });
    return [res.status, res.headers.get("access-control-allow-origin")];
  };

  for (const name of fonts)
    assert.deepEqual(await corsOf(linked(url, `fonts/${name}`)), [200, "*"], name);
  for (const name of others)
    assert.deepEqual(await corsOf(linked(url, `fonts/${name}`)), [200, null], name);
  assert.deepEqual(await corsOf(url), [200, null], "the page itself");
  assert.equal((await fetch(base + url)).headers.get("content-type"), "text/html; charset=utf-8");
  for (const path of [linked(url, "fonts/missing.woff2"), linked(url, "fonts/link.woff2")])
    assert.deepEqual(await corsOf(path), [404, null], path);
  // Sent raw so the dot segments reach the server's own path check rather than fetch's.
  for (const path of [`${dirname(url)}/../outside.woff2`, `${dirname(url)}/%2e%2e/outside.woff2`]) {
    const reply = await raw(path);
    assert.match(reply, /^HTTP\/1\.1 404/, path);
    assert.doesNotMatch(reply, /access-control-allow-origin/i, path);
  }
  assert.deepEqual(await corsOf(`/api/${opened.key}/session`), [401, null], "the api, untokened");
  const api = await fetch(`${base}/api/${opened.key}/session`, {
    headers: { ...headers, origin: "null" },
  });
  assert.equal(api.headers.get("access-control-allow-origin"), null, "the api, tokened");
  assert.deepEqual(await corsOf("/health"), [200, null]);
  // The daemon's own house faces load from a rendered Markdown page's frame; its sheets do not need to.
  assert.deepEqual(await corsOf("/house/fonts/literata/literata-latin-opsz-normal.woff2"), [
    200,
    "*",
  ]);
  assert.deepEqual(await corsOf("/markdown.css"), [200, null]);
  assert.deepEqual(await corsOf("/chrome.js"), [200, null]);
});

test("a Markdown file opens as a sandboxed page, and any other kind of file is refused with a reason", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-kinds-"));
  const open = async (name, body) => {
    writeFileSync(join(root, name), body);
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file: join(root, name) }),
    });
    return [res.status, await res.json()];
  };
  for (const name of ["plan.md", "PLAN.MARKDOWN", "plan.htm"]) {
    const [code, opened] = await open(name, "# Plan\n\nShip it.\n");
    assert.equal(code, 200, name);
    const res = await fetch(base + (await get(`/api/${opened.key}/session`)).artifactUrl);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", name);
    // Raw HTML in Markdown runs, so the rendered page keeps the sandbox every artifact has.
    assert.equal(
      res.headers.get("content-security-policy"),
      "sandbox allow-scripts allow-forms allow-popups",
      name,
    );
  }
  for (const name of ["notes.txt", "data.json", "app.js", "logo.svg", "Makefile"]) {
    assert.deepEqual(
      await open(name, "x"),
      [
        415,
        {
          error: `${name} cannot be reviewed: open an HTML (.html, .htm) or Markdown (.md, .markdown) file`,
        },
      ],
      name,
    );
  }
});

test("prompts queue, show in the chat, and reach one poller with anchors intact", async () => {
  const waiting = get(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=5000`);
  await until(async () => (await get(`/api/${key}/session`)).presence.state === "listening", {
    what: "the poll to attach",
  });
  const queued = await queueNotes(
    key,
    [{ prompt: "Shorter", selector: "#title", tag: "h1", text: "Rollout plan" }],
    'main\n  #title "Rollout plan"',
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
      `/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=10&ack=${result.prompts[0].uid}&epoch=${result.epoch}`,
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
  // A uid counts only within the session life that numbered it, so the two travel together.
  const poll = `/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=0`;
  assert.equal(await status(`${poll}&ack=1`, { headers }), 400, "an ack without its epoch");
  assert.equal(await status(`${poll}&epoch=0123456789abcdef`, { headers }), 400, "an epoch alone");
  assert.equal(await status(`${poll}&ack=1&epoch=nothex`, { headers }), 400, "a malformed epoch");
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

/**
 * Opens an event stream and yields one parsed event at a time, so a test can await an event.
 * `closed` settles with the code the server closed it with, which is how it refuses a stream.
 */
async function eventStream(path, token = srv.token) {
  const socket = new WebSocket(base.replace("http:", "ws:") + path, ["events", `bearer.${token}`]);
  const events = [];
  const waiting = [];
  let ended = false;
  socket.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (waiting.length) waiting.shift()(event);
    else events.push(event);
  });
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", (event) => {
      ended = true;
      for (const resolveNext of waiting.splice(0)) resolveNext(null);
      resolve(event.code);
    }),
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`the stream at ${path} did not open`)));
  });
  return {
    protocol: socket.protocol,
    closed,
    next() {
      if (events.length) return Promise.resolve(events.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
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
    close: () => socket.close(),
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
  // The fixture's session carries the notes earlier tests sent; the hello carries them too.
  const { chat } = await get(`/api/${opened.key}/session`);
  assert.ok(chat.length > 0);
  // An earlier test's poll on the fixture keeps it listening for the grace after that poll ended.
  await until(async () => (await get(`/api/${opened.key}/session`)).presence.state === "waiting", {
    what: "the last poll's grace to pass",
  });
  const first = await eventStream(`/api/${opened.key}/events`);
  assert.equal(first.protocol, "events", "the token is offered, never echoed back");
  assert.deepEqual(await first.next(), {
    type: "hello",
    artifactUrl,
    revision: 0,
    chat,
    presence: { state: "waiting" },
    ended: null,
    gone: false,
    drafts: [],
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
  assert.equal(await overflow.closed, 4429, `the ${limits.eventStreams + 1}th stream is refused`);
  for (const stream of [first, second, ...rest]) stream.close();
  const unknown = await eventStream(`/api/0000000000000000/events`);
  assert.equal(await unknown.closed, 4404, "a review that does not exist is refused for good");
  const forged = await eventStream(`/api/${opened.key}/events`, "0".repeat(48));
  assert.equal(await forged.closed, 4401, "a stream without the token is refused for good");
});

test("an event stream handshake from another origin or host, or without the subprotocol, is refused", async () => {
  const opened = await post("/api/sessions", { file: fixture });
  const handshake = (extra) =>
    new Promise((resolve, reject) => {
      const req = request(`${base}/api/${opened.key}/events`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          "sec-websocket-protocol": `events, bearer.${srv.token}`,
          ...extra,
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  assert.equal(await handshake({}), 101, "the well-formed handshake is accepted");
  assert.equal(await handshake({ origin: "http://evil.com" }), 403);
  assert.equal(await handshake({ host: "evil.com" }), 403);
  assert.equal(await handshake({ "sec-websocket-protocol": `bearer.${srv.token}` }), 400);
  assert.equal(await handshake({ "sec-websocket-version": "8" }), 400);
});

test("a poll whose connection dies before the reply redelivers the batch, never loses it", async () => {
  const file = join(dir, "redeliver.html");
  writeFileSync(file, "<p>x</p>");
  const k = (await post("/api/sessions", { file })).key;
  await queueNotes(k, [{ prompt: "do not lose me", selector: "#p", tag: "p", text: "x" }]);
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
  // Answered is when the agent shows working; a poll before then would simply be the first one.
  await until(async () => (await get(`/api/${k}/session`)).presence.state === "working", {
    what: "the dropped poll to be answered",
  });
  const again = await get(`/api/poll?file=${encodeURIComponent(file)}&timeoutMs=1000`);
  assert.equal(again.status, "feedback");
  assert.equal(again.prompts[0].prompt, "do not lose me");
  assert.equal(again.prompts[0].uid, 1, "the redelivered note keeps its uid");
});

test("the reviewer ends the review with the queue attached, and only a reopen revives it", async () => {
  const opened = await post("/api/sessions", { file: fixture });
  await post(
    `/api/${opened.key}/drafts`,
    { draft: { prompt: "One last thing", selector: "#title", tag: "h1", text: "Rollout" } },
    { origin: base },
  );
  const ended = await post(
    `/api/${opened.key}/end`,
    { by: "user", drafts: "send" },
    { origin: base },
  );
  assert.deepEqual(ended, { status: "ended", ended_by: "user", queued: 1 });
  const last = await get(`/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=1000`);
  assert.equal(last.status, "feedback");
  assert.equal(last.session_ended, true);
  assert.equal(last.prompts[0].prompt, "One last thing");
  assert.deepEqual(
    await get(
      `/api/poll?file=${encodeURIComponent(fixture)}&timeoutMs=1000&ack=${last.prompts[0].uid}&epoch=${last.epoch}`,
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
  assert.equal(
    await status(`/api/${opened.key}/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({ by: "user", drafts: "keep" }),
    }),
    400,
  );
});

test("unsent notes live on the server: added, removed, sent as one batch, and kept across a restart", async () => {
  const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-drafts-"));
  const file = join(stateDir, "drafted.html");
  writeFileSync(file, "<h1 id='t'>x</h1>");
  let daemon = await serve({ stateDir, port: 0, idleMs: 60_000 });
  const once = (method, path, body) =>
    fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  // fetch's pool may hand the first request after the restart a connection the old daemon closed;
  // a browser retries that by itself, so this does too, once.
  const call = (method, path, body) =>
    once(method, path, body).catch(() => once(method, path, body));
  try {
    const k = (await call("POST", "/api/sessions", { file })).body.key;
    const note = (prompt) => ({ prompt, selector: "#t", tag: "h1", text: "x" });
    const first = await call("POST", `/api/${k}/drafts`, { draft: note("one"), structure: "main" });
    assert.equal(first.status, 200);
    const { drafts } = (await call("POST", `/api/${k}/drafts`, { draft: note("two") })).body;
    assert.deepEqual(
      drafts.map((d) => d.prompt),
      ["one", "two"],
    );
    assert.match(drafts[0].id, /^[0-9a-f]{16}$/);
    assert.ok(Date.parse(drafts[0].at) <= Date.parse(drafts[1].at), "stamped as each arrives");
    // A draft is validated as it arrives, not when it is sent, and the page cannot stamp it.
    const bad = await call("POST", `/api/${k}/drafts`, { draft: { ...note(""), at: "x" } });
    assert.equal(bad.status, 400);

    // The daemon goes away and comes back: the notes are still there, and still unsent.
    await daemon.close();
    daemon = await serve({ stateDir, port: 0, idleMs: 60_000 });
    assert.deepEqual(
      (await call("GET", `/api/${k}/session`)).body.drafts.map((d) => d.prompt),
      ["one", "two"],
    );
    assert.equal(
      (await call("GET", `/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`)).body.status,
      "waiting",
    );

    const removed = await call("DELETE", `/api/${k}/drafts/${drafts[0].id}`);
    assert.deepEqual(
      removed.body.drafts.map((d) => d.prompt),
      ["two"],
    );
    assert.equal(
      (await call("DELETE", `/api/${k}/drafts/${drafts[0].id}`)).status,
      200,
      "idempotent",
    );
    assert.equal((await call("DELETE", `/api/${k}/drafts/__proto__`)).status, 404);

    // An edit rewrites the instruction and nothing else: the note keeps its target and its stamp.
    const edited = await call("PATCH", `/api/${k}/drafts/${drafts[1].id}`, {
      prompt: "two, said better",
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.drafts, [{ ...drafts[1], prompt: "two, said better" }]);
    assert.equal(
      (await call("PATCH", `/api/${k}/drafts/${drafts[1].id}`, { prompt: " " })).status,
      400,
      "an edit cannot empty a note",
    );
    const sentElsewhere = await call("PATCH", `/api/${k}/drafts/${drafts[0].id}`, { prompt: "x" });
    assert.deepEqual(
      [sentElsewhere.status, sentElsewhere.body.error],
      [404, "that note was already sent or removed"],
    );

    assert.equal((await call("POST", `/api/${k}/prompts`, {})).body.accepted, 1);
    assert.deepEqual((await call("GET", `/api/${k}/session`)).body.drafts, []);
    assert.equal((await call("POST", `/api/${k}/prompts`, {})).status, 400, "nothing to send");
    const polled = (await call("GET", `/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`))
      .body;
    assert.deepEqual(
      polled.prompts.map((p) => [p.uid, p.prompt, p.at === drafts[1].at]),
      [[1, "two, said better", true]],
    );
    assert.equal(polled.structure, "main", "the outline taken with the notes goes with them");

    for (let i = 0; i < limits.promptsPerRequest; i += 1)
      await call("POST", `/api/${k}/drafts`, { draft: note(`n${i}`) });
    assert.equal((await call("POST", `/api/${k}/drafts`, { draft: note("over") })).status, 429);
    await call("POST", `/api/${k}/end`, { by: "user", drafts: "discard" });
    assert.deepEqual((await call("GET", `/api/${k}/session`)).body.drafts, []);
  } finally {
    await daemon.close();
  }
});

test("a restart keeps its port and token, and a taken port means a new port and a new token", async () => {
  const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-restart-"));
  const first = await serve({ stateDir, port: 0, idleMs: 60_000 });
  await first.close();
  const second = await serve({ stateDir, port: 0, idleMs: 60_000 });
  assert.equal(second.port, first.port, "a tab on the old address can reach the new daemon");
  assert.equal(second.token, first.token, "and the token in its fragment still works");
  await second.close();

  // Something else took the port while no daemon held it: whatever it is gets nothing of ours.
  const squatter = createServer((req, res) => res.end()).listen(first.port, "127.0.0.1");
  await new Promise((resolve) => squatter.once("listening", resolve));
  try {
    const third = await serve({ stateDir, port: 0, idleMs: 60_000 });
    assert.notEqual(third.port, first.port);
    assert.notEqual(third.token, first.token, "a token is never carried to a new port");
    const recorded = JSON.parse(readFileSync(join(stateDir, "server.json"), "utf8"));
    assert.deepEqual([recorded.port, recorded.token], [third.port, third.token]);
    await third.close();
  } finally {
    squatter.close();
  }
});

test("health proves the token without revealing it, and only for a well-formed challenge", async () => {
  const challenge = "ab".repeat(16);
  const answer = await fetch(`${base}/health?challenge=${challenge}`).then((r) => r.json());
  assert.equal(answer.proof, tokenProof(srv.token, challenge));
  assert.ok(!JSON.stringify(answer).includes(srv.token));
  assert.equal((await fetch(`${base}/health`).then((r) => r.json())).proof, undefined);
  assert.equal(
    (await fetch(`${base}/health?challenge=${srv.token}`).then((r) => r.json())).proof,
    undefined,
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
  const watching = new WebSocket(`ws://127.0.0.1:${held.port}/api/${session.key}/events`, [
    "events",
    `bearer.${held.token}`,
  ]);
  await new Promise((resolve) => watching.addEventListener("open", resolve));
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
  watching.close();
  await held.close();
});

test("a waiting poll whose batch was taken is answered with the note behind it when its file goes, and the daemon keeps serving", async (t) => {
  if (!(await watchAvailable())) return t.skip("file watching is refused in this sandbox");
  const stateDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-server-gone-"));
  const folder = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-server-folder-"));
  const file = join(folder, "plan.html");
  copyFileSync(fixture, file);
  const daemon = await serve({ stateDir, port: 0, idleMs: 60_000 });
  const url = `http://127.0.0.1:${daemon.port}`;
  const auth = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
  const session = (path) => fetch(url + path, { headers: auth }).then((res) => res.json());
  let socket;
  try {
    const { key } = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ file }),
    }).then((res) => res.json());
    socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/api/${key}/events`, [
      "events",
      `bearer.${daemon.token}`,
    ]);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    const note = (text) => ({ prompt: text, selector: "#t", tag: "h1", text: "Title" });
    const poll = (query) =>
      fetch(`${url}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=20000&${query}`, {
        headers: auth,
      }).then((res) => res.json());
    const epoch = new SessionStore(stateDir).get(key).epoch;
    const waiting = poll(`ack=1&epoch=${epoch}`);
    await until(async () => (await session(`/api/${key}/session`)).presence.state === "listening", {
      what: "the poll to attach",
    });
    new SessionStore(stateDir).queue(key, [note("batch one")]);
    const refused = await fetch(`${url}/api/${key}/drafts`, {
      method: "POST",
      headers: { ...auth, origin: url },
      body: JSON.stringify({ draft: note("typed while the other process wrote") }),
    });
    assert.equal(refused.status, 409, "a write over a newer copy is refused");
    const taken = await poll("");
    assert.deepEqual(
      taken.prompts.map((p) => p.prompt),
      ["batch one"],
      "the daemon took the newer copy's batch",
    );
    new SessionStore(stateDir).queue(key, [note("the note behind the batch")]);
    renameSync(file, `${file}.away`);
    const answer = await waiting;
    assert.equal(answer.status, "feedback", "the poll is answered before its timeout");
    assert.deepEqual(
      answer.prompts.map((p) => p.prompt),
      ["the note behind the batch"],
    );
    assert.equal((await fetch(`${url}/health`)).status, 200, "the daemon still serves");
  } finally {
    socket?.close();
    await daemon.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});
