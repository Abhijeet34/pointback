import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { env, name, version } from "./identity.js";
import { readJson } from "./state-dir.js";

const bin = new URL(`../bin/${name}.js`, import.meta.url).pathname;

/** The running server's address and token, or null when none is recorded. */
export function readServerInfo(stateDir) {
  const info = readJson(join(stateDir, "server.json"));
  return info && typeof info.port === "number" && typeof info.token === "string" ? info : null;
}

async function health(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? /** @type {any} */ (await res.json()) : null;
  } catch {
    return null;
  }
}

export async function api(info, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = /** @type {any} */ (await res.json());
  if (!res.ok) throw new Error(json.error ?? `${method} ${path} failed with ${res.status}`);
  return json;
}

/**
 * Returns a live server, starting one when none answers. A server of another version
 * is asked to stop first, so the CLI and the daemon never disagree about the protocol.
 */
export async function ensureServer(stateDir, environment = process.env) {
  const existing = readServerInfo(stateDir);
  if (existing) {
    const status = await health(existing);
    if (status?.version === version) return existing;
    if (status) await api(existing, "POST", "/shutdown").catch(() => {});
  }
  const log = openSync(join(stateDir, "server.log"), "a", 0o600);
  const child = spawn(process.execPath, [bin, "server"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: environment,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readServerInfo(stateDir);
    if (info && info.pid === child.pid && (await health(info))?.version === version) return info;
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`server did not start; see ${join(stateDir, "server.log")}`);
}

/** Opens the URL with the platform's own opener, arguments passed as an array so nothing is shell-parsed. */
export function openBrowser(url, platform = process.platform) {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function shouldOpenBrowser(flags, environment = process.env) {
  return !flags.noOpen && env("NO_OPEN", environment) === undefined;
}
