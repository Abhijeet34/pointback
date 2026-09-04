import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { env, name, version } from "./identity.js";
import { readJson } from "./state-dir.js";

// fileURLToPath, never URL.pathname: on Windows that yields "/C:/...", which spawn cannot run.
const bin = fileURLToPath(new URL(`../bin/${name}.js`, import.meta.url));

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
    // Without this a detached console application on Windows opens a console window of its
    // own and leaves it on the reviewer's desktop for as long as the daemon lives.
    windowsHide: true,
  });
  child.unref();
  // Bounded by attempts as well as by the clock. Every turn of this loop can cost a probe's
  // own `AbortSignal.timeout`, so a budget written only in milliseconds is really a budget in
  // however many looks the machine can afford - and a busy windows-2025 runner affords few.
  // The child exiting is the one fact that means "not coming"; everything else means "not yet".
  const startedAt = Date.now();
  let probes = 0;
  for (;;) {
    probes += 1;
    const info = readServerInfo(stateDir);
    if (info && info.pid === child.pid && (await health(info))?.version === version) return info;
    if (child.exitCode !== null) break;
    if (probes >= START_PROBES && Date.now() - startedAt >= START_TIMEOUT_MS) break;
    await sleep(50);
  }
  throw new Error(startFailure(stateDir, child, Date.now() - startedAt, probes));
}

/** How long, and how many looks, a spawned daemon gets to answer before it is called dead. */
const START_TIMEOUT_MS = 10_000;
const START_PROBES = 20;

/**
 * Says why the daemon is not there, rather than naming a file to go and read. Pointing at
 * `server.log` is no help wherever the log cannot be reached afterwards, which is every CI
 * runner: run 33875622583, attempt 19, failed here on windows-2025 and left nothing behind
 * but the path. The daemon's own last words are what identifies a start failure.
 */
function startFailure(stateDir, child, elapsedMs, probes) {
  const log = join(stateDir, "server.log");
  let said;
  try {
    said = readFileSync(log, "utf8").trim().split(/\r?\n/).slice(-6).join(" | ");
  } catch {
    said = "(unreadable)";
  }
  const state = child.exitCode === null ? "it is still running" : `it exited ${child.exitCode}`;
  return (
    `server did not start: ${state} after ${elapsedMs} ms and ${probes} probes. ` +
    `${log} says: ${said || "(nothing)"}`
  );
}

/**
 * Opens the URL with the platform's own opener. Arguments go as an array rather than a
 * command line; on Windows `start` is a cmd.exe builtin, so cmd parses them again, and the
 * only URL this is ever called with is one this server built from a port and two hex strings.
 */
export function openBrowser(url, platform = process.platform) {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export function shouldOpenBrowser(flags, environment = process.env) {
  return !flags.noOpen && env("NO_OPEN", environment) === undefined;
}
