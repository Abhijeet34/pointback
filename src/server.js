import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { KEY_PATTERN, TOKEN_PATTERN, resolveAsset } from "./artifact-path.js";
import {
  ARTIFACT_HEADERS,
  CHROME_HEADERS,
  HttpError,
  STATIC_HEADERS,
  assertBearer,
  assertHost,
  assertOrigin,
  readJsonBody,
  sendJson,
} from "./http-guard.js";
import { name, version } from "./identity.js";
import { injectSdk } from "./inject.js";
import { limits } from "./limits.js";
import { SessionStore } from "./session-store.js";
import { writeJsonAtomic } from "./state-dir.js";

const SDK_PATH = "/sdk.js";
const browserDir = new URL("./browser/", import.meta.url);
const staticFiles = {
  "/sdk.js": ["sdk.js", "text/javascript; charset=utf-8"],
  "/chrome.js": ["chrome.js", "text/javascript; charset=utf-8"],
  "/chrome.css": ["chrome.css", "text/css; charset=utf-8"],
};
const chromeHtml = readFileSync(new URL("chrome.html", browserDir), "utf8");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/**
 * Starts the loopback server and records how to reach it in `server.json`, which
 * only the owning user can read: the token in it is the one credential that exists.
 */
export function serve({ stateDir, port = 0, idleMs = limits.idleShutdownMs, onIdle = () => {} }) {
  const token = randomBytes(24).toString("hex");
  const store = new SessionStore(join(stateDir, "state.json"));
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close().then(onIdle), idleMs);
    idleTimer.unref();
  };

  const boundPort = () => /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const server = createServer(async (req, res) => {
    touch();
    try {
      await route(req, res, { store, token, port: boundPort() });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error(error);
      if (status === 413) res.setHeader("connection", "close");
      if (!res.headersSent) sendJson(res, status, { error: error.message });
      else res.destroy();
    }
  });
  server.requestTimeout = limits.pollTimeoutMaxMs + 10_000;
  server.headersTimeout = 30_000;

  const close = () =>
    new Promise((resolve) => {
      clearTimeout(idleTimer);
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = boundPort();
      writeJsonAtomic(join(stateDir, "server.json"), {
        pid: process.pid,
        port: bound,
        token,
        version,
        startedAt: new Date().toISOString(),
      });
      touch();
      resolve({ port: bound, token, close, server });
    });
  });
  return listening;
}

async function route(req, res, ctx) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname } = url;
  assertHost(req, ctx.port);

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true, app: name, version });
  }
  if (req.method === "POST" && pathname === "/shutdown") {
    assertOrigin(req, ctx.port);
    assertBearer(req, ctx.token);
    sendJson(res, 200, { status: "stopping" });
    setImmediate(() => process.exit(0));
    return;
  }
  if (req.method === "GET" && Object.hasOwn(staticFiles, pathname)) {
    const [file, type] = staticFiles[pathname];
    res.writeHead(200, { ...STATIC_HEADERS, "content-type": type });
    return res.end(readFileSync(new URL(file, browserDir)));
  }

  const chrome = pathname.match(/^\/session\/([^/]+)$/);
  if (req.method === "GET" && chrome) {
    ctx.store.get(chrome[1]);
    res.writeHead(200, { ...CHROME_HEADERS, "content-type": "text/html; charset=utf-8" });
    return res.end(chromeHtml);
  }

  const artifact = pathname.match(/^\/artifact\/([^/]+)\/([^/]+)\/(.*)$/);
  if (req.method === "GET" && artifact) return serveArtifact(res, ctx.store, artifact);

  if (pathname.startsWith("/api/")) return api(req, res, url, ctx);
  throw new HttpError(404, "not found");
}

async function api(req, res, url, ctx) {
  const { pathname } = url;
  assertBearer(req, ctx.token);
  if (req.method !== "GET") assertOrigin(req, ctx.port);

  if (req.method === "POST" && pathname === "/api/sessions") {
    const body = await readJsonBody(req);
    if (typeof body.file !== "string" || body.file === "")
      throw new HttpError(400, "file required");
    let session;
    try {
      session = ctx.store.open(body.file);
    } catch (error) {
      if (error?.code === "ENOENT") throw new HttpError(404, `no such file: ${body.file}`);
      throw error;
    }
    return sendJson(res, 200, {
      key: session.key,
      file: session.file,
      url: `http://127.0.0.1:${ctx.port}/session/${session.key}`,
    });
  }

  if (req.method === "GET" && pathname === "/api/poll") {
    const file = url.searchParams.get("file");
    if (!file) throw new HttpError(400, "file required");
    const key = ctx.store.keyFor(file);
    const timeoutMs = pollTimeout(url.searchParams.get("timeoutMs"));
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const prompts = await ctx.store.waitForFeedback(key, timeoutMs, controller.signal);
    if (controller.signal.aborted && prompts === null) return;
    return sendJson(res, 200, prompts ? { status: "feedback", prompts } : { status: "waiting" });
  }

  const keyed = pathname.match(/^\/api\/([^/]+)\/(session|prompts)$/);
  if (!keyed) throw new HttpError(404, "not found");
  const [, key, action] = keyed;
  if (req.method === "GET" && action === "session")
    return sendJson(res, 200, ctx.store.bootstrap(key));
  if (req.method === "POST" && action === "prompts") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, ctx.store.queue(key, body.prompts));
  }
  throw new HttpError(405, "method not allowed");
}

function pollTimeout(raw) {
  if (raw === null) return limits.pollTimeoutDefaultMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new HttpError(400, "timeoutMs must be a non-negative integer");
  return Math.min(value, limits.pollTimeoutMaxMs);
}

function serveArtifact(res, store, match) {
  const [, key, token, rest] = match;
  if (!KEY_PATTERN.test(key) || !TOKEN_PATTERN.test(token)) throw new HttpError(404, "not found");
  const session = store.get(key);
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(session.assetToken))) {
    throw new HttpError(404, "not found");
  }
  const root = dirname(session.file);
  const file = resolveAsset(root, rest);
  if (!file) throw new HttpError(404, "not found");
  const type = contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
  if (file === session.file) {
    res.writeHead(200, { ...ARTIFACT_HEADERS, "content-type": contentTypes[".html"] });
    return res.end(injectSdk(readFileSync(file, "utf8"), SDK_PATH));
  }
  res.writeHead(200, { ...ARTIFACT_HEADERS, "content-type": type });
  res.end(readFileSync(file));
}
