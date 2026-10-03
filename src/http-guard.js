import { createHmac, timingSafeEqual } from "node:crypto";
import { limits } from "./limits.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Only the loopback names the server itself is reachable by; anything else is a rebinding attempt. */
export function assertHost(req, port) {
  const host = req.headers.host;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!host || !allowed.has(host.toLowerCase())) throw new HttpError(403, "unexpected host");
}

/** A state-changing request from a browser must come from this server's own page, or from no page at all. */
export function assertOrigin(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (!allowed.has(origin.toLowerCase())) throw new HttpError(403, "unexpected origin");
}

export const SERVER_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
export const CHALLENGE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Proof that a server holds the token, without the token crossing the wire: a client presents the
 * token only to a server that answers its fresh challenge with this. The token outlives a restart,
 * so whatever listens on a port a dead daemon left must never be handed it.
 */
export function tokenProof(token, challenge) {
  return createHmac("sha256", token).update(challenge).digest("hex");
}

export function assertBearer(req, token) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpError(401, "missing or wrong token");
}

/** Reads a JSON body, refusing anything past the cap before it is buffered whole. */
export function readJsonBody(req, maxBytes = limits.requestBodyBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading; the 413 goes out with connection: close so the rest is never buffered.
        reject(new HttpError(413, `body over ${maxBytes} bytes`));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolvePromise({});
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("not an object");
        }
        resolvePromise(value);
      } catch {
        reject(new HttpError(400, "body is not a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

const COMMON_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * The loopback name the other of the chrome and its wrapper frame is served under. The wrapper must
 * be a different origin from the chrome, so that no click or key in the chrome activates it, and a
 * different site, so that Chromium gives it a process of its own; the daemon answers to both names on
 * one port, so each is served under the name the other is not.
 */
export function pairedHost(host) {
  const [, name, port] = /^(.*):(\d+)$/.exec(host.toLowerCase()) ?? [];
  return `${name === "localhost" ? "127.0.0.1" : "localhost"}:${port}`;
}

/**
 * The chrome page runs only this server's own scripts, styles and fonts, frames only its wrapper,
 * connects only here, its event stream included, and can never be framed. `host` is the request's Host header, which `assertHost` already held to
 * the loopback names.
 */
export function chromeHeaders(host) {
  return {
    ...COMMON_HEADERS,
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
      `connect-src 'self' ws://${host}; frame-src http://${pairedHost(host)}; base-uri 'none'; ` +
      "form-action 'none'; " +
      "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}

/**
 * The wrapper frame runs only its own script and sheet, frames only the page under review, which is
 * served under the chrome's name, and only the chrome may frame it.
 */
export function wrapperHeaders(host) {
  const chrome = `http://${pairedHost(host)}`;
  return {
    ...COMMON_HEADERS,
    "content-security-policy":
      `default-src 'none'; script-src 'self'; style-src 'self'; frame-src ${chrome}; ` +
      `base-uri 'none'; form-action 'none'; frame-ancestors ${chrome}`,
  };
}

/**
 * The artifact keeps scripts but loses its origin, so it can neither read the chrome nor
 * call the API. Being opaque-origin, its own asset loads count as cross-origin, which is
 * why these responses must not carry a same-origin resource policy.
 */
export const ARTIFACT_HEADERS = {
  ...COMMON_HEADERS,
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups",
};

/**
 * A font is the one artifact asset the frame may read cross-origin. Its opaque origin makes every
 * @font-face load a CORS request, so without this the page paints in fallback fonts; any wider
 * grant would let a hostile page read and send out whatever else sits under the root.
 */
export const FONT_HEADERS = { ...ARTIFACT_HEADERS, "access-control-allow-origin": "*" };

export const STATIC_HEADERS = COMMON_HEADERS;

export function sendJson(res, status, value, headers = COMMON_HEADERS) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
