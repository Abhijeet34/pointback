import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { daemonHolds, pidAlive } from "./daemon-lock.js";
import { tokenProof } from "./http-guard.js";
import { env, name, version } from "./identity.js";
import { readJson, writeJsonAtomic } from "./state-dir.js";

// fileURLToPath, never URL.pathname: on Windows that yields "/C:/...", which spawn cannot run.
const bin = fileURLToPath(new URL(`../bin/${name}.js`, import.meta.url));

/** The running server's address and token, or null when none is recorded. */
export function readServerInfo(stateDir) {
  const info = readJson(join(stateDir, "server.json"));
  return info && typeof info.port === "number" && typeof info.token === "string" ? info : null;
}

/**
 * What answers on the recorded port, and whether it proved it holds the recorded token. Only a
 * proven server is ever sent the token: the port of a daemon that exited can be taken by anything.
 */
export async function health(info) {
  const challenge = randomBytes(16).toString("hex");
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health?challenge=${challenge}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const status = /** @type {any} */ (await res.json());
    return { ...status, proven: status.proof === tokenProof(info.token, challenge) };
  } catch {
    return null;
  }
}

export async function api(info, method, path, body, retried = false) {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = /** @type {any} */ (await res.json());
  // A refused write left the daemon holding the copy another process wrote, so the same call made once
  // more lands on it. The second refusal is the answer.
  if (res.status === 409 && !retried) return api(info, method, path, body, true);
  // The body rides on the error, because a refusal such as a gone file is an answer to print.
  if (!res.ok)
    throw Object.assign(new Error(json.error ?? `${method} ${path} failed with ${res.status}`), {
      answer: json,
      status: res.status,
    });
  return json;
}

/**
 * Returns a live server, starting one when none answers. A server of another version
 * is asked to stop first, so the CLI and the daemon never disagree about the protocol.
 */
export async function ensureServer(stateDir, environment = process.env) {
  const older = ({ port, pid }) =>
    new Error(
      `an older ${name} daemon${Number.isInteger(pid) ? ` (pid ${pid})` : ""} on port ${port} did not stop; end that process and retry`,
    );
  const serves = (status) => status?.proven && status.version === version;
  const existing = readServerInfo(stateDir);
  if (existing) {
    const status = await health(existing);
    if (serves(status)) return existing;
    if (status?.proven || (status?.app === name && recordHolds(existing, status)))
      await stopServer(stateDir, existing, status);
  }
  // A second daemon beside one that did not stop would split the directory, so the start refuses.
  // The record is read afresh there, and a concurrent start's daemon may have published it since
  // the look above: one that proves the token and runs this version is used, never named as older.
  const holding = await refusingServer(stateDir);
  if (holding) {
    const info = readServerInfo(stateDir);
    if (info && serves(await health(info))) return info;
    throw older(holding);
  }
  const log = openSync(join(stateDir, "server.log"), "a", 0o600);
  const start = () => {
    const started = spawn(process.execPath, [bin, "server"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: environment,
      // Without this a detached console application on Windows opens a console window of its
      // own and leaves it on the reviewer's desktop for as long as the daemon lives.
      windowsHide: true,
    });
    started.unref();
    return started;
  };
  let child = start();
  // Bounded by attempts as well as by the clock. Every turn of this loop can cost a probe's
  // own `AbortSignal.timeout`, so a budget written only in milliseconds is really a budget in
  // however many looks the machine can afford - and a busy windows-2025 runner affords few.
  // Any proven daemon will do, because concurrent starts each spawn one and only one keeps the
  // directory; the rest exit 0. A start that stepped aside for a daemon that has since let go,
  // one caught on its way out, is replaced; only a failed exit means "not coming".
  const startedAt = Date.now();
  let probes = 0;
  for (;;) {
    probes += 1;
    const info = readServerInfo(stateDir);
    if (info && serves(await health(info))) return info;
    if (child.exitCode !== null && child.exitCode !== 0) break;
    if (child.exitCode === 0 && !(await daemonHolds(stateDir))) child = start();
    if (probes >= START_PROBES && Date.now() - startedAt >= START_TIMEOUT_MS) break;
    await sleep(50);
  }
  throw new Error(startFailure(stateDir, child, Date.now() - startedAt, probes));
}

/**
 * Asks the recorded server to stop. A daemon from before the proof existed answers as this app
 * but cannot prove it holds the token, and still has to stop, or two would share its sessions; it
 * has then been shown the token, so the token is retired whether or not it stopped, and the next
 * daemon mints a fresh one. The record keeps its port, so a start still finds a daemon that refused.
 *
 * "stopping" is only the daemon's promise: it has stopped once its process is gone or nothing listens
 * on its port, either of which frees the port, so a start right after comes back on it and the tabs
 * holding it reconnect. One still there after STOP_TIMEOUT_MS did not stop.
 */
export async function stopServer(stateDir, info, status) {
  const asked = await api(info, "POST", "/shutdown").then(
    () => true,
    () => false,
  );
  if (!status.proven) writeJsonAtomic(join(stateDir, "server.json"), { ...info, token: null });
  if (!asked) return false;
  const pid = Number.isInteger(info.pid) ? info.pid : status.pid;
  // The pid goes first: once it is gone, the port may rightly belong to a concurrent start's daemon.
  const gone = async (ms) =>
    (Number.isInteger(pid) && !pidAlive(pid)) || !(await listening(info.port, ms));
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (!(await gone(deadline - Date.now()))) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** How long a daemon that answered "stopping" gets to exit before it is said not to have stopped. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Whether anything accepts a connection on the loopback port; only a refusal says nothing does. A probe
 * that gets no answer within `ms` is still listening, so the caller's deadline is never overrun.
 */
function listening(port, ms) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(Math.max(1, ms), () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (/** @type {NodeJS.ErrnoException} */ error) =>
      resolve(error.code !== "ECONNREFUSED"),
    );
  });
}

/**
 * Whether a record's server is the one still holding its port. Its process must be alive, and when the
 * answer reports a pid it must be the record's, so a port that a later daemon took is not the record's.
 * Only signal 0 is ever sent, to test liveness.
 */
export function recordHolds(record, status) {
  if (Number.isInteger(record.pid) && !pidAlive(record.pid)) return false;
  const reported = Number.isInteger(status?.pid) && Number.isInteger(record.pid);
  return !reported || status.pid === record.pid;
}

/**
 * The recorded server when it still holds its port: its port answers as this app, or accepts the
 * connection and is too busy to answer, with its token or with the token retired. A server that was
 * asked to stop and did not is still there, so a start and `stop` both need to name it.
 */
export async function refusingServer(stateDir) {
  const record = readJson(join(stateDir, "server.json"));
  if (!Number.isInteger(record?.port) || !recordHolds(record, null)) return null;
  try {
    const challenge = randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${record.port}/health?challenge=${challenge}`, {
      signal: AbortSignal.timeout(1500),
    });
    const status = /** @type {any} */ (await res.json());
    return status?.app === name && recordHolds(record, status) ? record : null;
  } catch (error) {
    const busy = error.name === "TimeoutError" || error.name === "AbortError";
    return busy ? record : null;
  }
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
