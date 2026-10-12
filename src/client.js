import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { daemonHolds, pidAlive, probeTimeout } from "./daemon-lock.js";
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
 * `ceiling` caps the probe's wall time.
 */
export async function health(info, ceiling) {
  const challenge = randomBytes(16).toString("hex");
  const probe = probeTimeout(1500, ceiling);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health?challenge=${challenge}`, {
      signal: probe.signal,
    });
    if (!res.ok) return null;
    const status = /** @type {any} */ (await res.json());
    return { ...status, proven: status.proof === tokenProof(info.token, challenge) };
  } catch {
    return null;
  } finally {
    probe.done();
  }
}

/**
 * How long the daemon gets to answer a request, beyond the `holdMs` a poll asks it to hold one. A
 * daemon that proved its token and then stalled held an open for Node's own 300 s and a bare "fetch
 * failed"; this keeps an open, start included, inside a two-minute tool call (START_WALL_MS).
 */
const REQUEST_MS = 30_000;

/**
 * Calls the daemon's API. A caller's `signal` replaces the REQUEST_MS bound.
 * @param {any} info
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ signal?: AbortSignal, holdMs?: number }} [options]
 */
export async function api(info, method, path, body, { signal, holdMs = 0 } = {}) {
  const bound = signal ? null : probeTimeout(holdMs + REQUEST_MS, holdMs + REQUEST_MS);
  const call = async () => {
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      signal: signal ?? bound.signal,
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: /** @type {any} */ (await res.json()) };
  };
  try {
    let { res, json } = await call();
    // A refused write left the daemon holding the copy another process wrote, so the same call made
    // once more lands on it. The second refusal is the answer.
    if (res.status === 409) ({ res, json } = await call());
    // The body rides on the error, because a refusal such as a gone file is an answer to print.
    if (!res.ok)
      throw Object.assign(new Error(json.error ?? `${method} ${path} failed with ${res.status}`), {
        answer: json,
        status: res.status,
      });
    return json;
  } catch (error) {
    if (!bound?.signal.aborted) throw error;
    const route = path.split("?")[0];
    throw new Error(
      `the ${name} daemon on port ${info.port} did not answer ${method} ${route} within ${(holdMs + REQUEST_MS) / 1000} s, so it may be stalled; end the process listening on port ${info.port} and retry`,
      { cause: error },
    );
  } finally {
    bound?.done();
  }
}

/**
 * Returns a live server, starting one when none answers. A server of another version
 * is asked to stop first, so the CLI and the daemon never disagree about the protocol.
 * The whole of it is bounded by `wallMs` of wall time: every look it takes is capped at what is left.
 */
export async function ensureServer(stateDir, environment = process.env, wallMs = START_WALL_MS) {
  const began = performance.now();
  const left = () => Math.max(0, began + wallMs - performance.now());
  const older = ({ port, pid }) =>
    new Error(
      `an older ${name} daemon${Number.isInteger(pid) ? ` (pid ${pid})` : ""} on port ${port} did not stop; end that process and retry`,
    );
  const serves = (status) => status?.proven && status.version === version;
  const existing = readServerInfo(stateDir);
  if (existing) {
    const status = await health(existing, left());
    if (serves(status)) return existing;
    if (status?.proven || (status?.app === name && recordHolds(existing, status)))
      await stopServer(stateDir, existing, status, Math.min(STOP_BACKSTOP_MS, left()));
  }
  // A second daemon beside one that did not stop would split the directory, so the start refuses.
  // The record is read afresh there, and a concurrent start's daemon may have published it since
  // the look above: one that proves the token and runs this version is used, never named as older.
  const holding = await refusingServer(stateDir, left());
  if (holding) {
    const info = readServerInfo(stateDir);
    if (info && serves(await health(info, left()))) return info;
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
  // Any proven daemon will do, because concurrent starts each spawn one and only one keeps the
  // directory; the rest exit 0. While the daemon this CLI started is alive it is still starting,
  // however long the machine holds it before its claim, so it is waited for. Once it has exited, a
  // live holder of the lock is a start in progress to wait for; with none left, a start that stepped
  // aside (exit 0), for a daemon caught on its way out, is replaced, and a failed one is reported.
  // START_WALL_MS is the one bound on all of it (measurements in docs/ENGINEERING-NOTES.md).
  let probes = 0;
  while (left() > 0) {
    probes += 1;
    const info = readServerInfo(stateDir);
    if (info && serves(await health(info, left()))) return info;
    if (child.exitCode !== null && !(await daemonHolds(stateDir, left()))) {
      if (child.exitCode !== 0) break;
      child = start();
    }
    await sleep(50);
  }
  throw new Error(startFailure(stateDir, child, Math.round(performance.now() - began), probes));
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
export async function stopServer(stateDir, info, status, backstopMs = STOP_BACKSTOP_MS) {
  const backstop = Date.now() + backstopMs;
  const shutdown = probeTimeout(backstopMs, backstopMs);
  const asked = await api(info, "POST", "/shutdown", undefined, { signal: shutdown.signal }).then(
    () => true,
    () => false,
  );
  shutdown.done();
  if (!status.proven) writeJsonAtomic(join(stateDir, "server.json"), { ...info, token: null });
  if (!asked) return false;
  const pid = Number.isInteger(info.pid) ? info.pid : status.pid;
  // The pid goes first: once it is gone, the port may rightly belong to a concurrent start's daemon.
  const gone = async (ms) =>
    (Number.isInteger(pid) && !pidAlive(pid)) ||
    !(await listening(info.port, ms, backstop - Date.now()));
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (!(await gone(deadline - Date.now()))) {
    if (Date.now() >= deadline || Date.now() >= backstop) return false;
    await sleep(50);
  }
  return true;
}

/** How long a daemon that answered "stopping" gets to exit before it is said not to have stopped. */
const STOP_TIMEOUT_MS = 5_000;
/**
 * The wall bound on a whole start, so an open always answers within it. Sized over the slowest start
 * measured on a CI runner, eight cold opens at once on windows-2025 in 13249 ms (138 hunt logs, docs/
 * ENGINEERING-NOTES.md), and the worst stalled probe, 11670 ms, at over four times either, while an
 * open's answer still fits a two-minute tool call with room for the CLI's own boot.
 */
const START_WALL_MS = 60_000;
/**
 * The wall backstop on the whole stop: STOP_TIMEOUT_MS plus the worst stalled probe measured, 11670 ms
 * (windows-2025 hunt 37349003233, job 111894797244), rounded up to 20 s. A stop is given up at it even
 * when starvation has spent no running time, so no look outlasts it.
 */
const STOP_BACKSTOP_MS = 20_000;

/**
 * Whether anything accepts a connection on the loopback port; only a refusal says nothing does. A probe
 * that gets no answer within `ms` of running time is still listening. Its wall ceiling is what remains
 * of stopServer's backstop, so no look outlasts the backstop.
 */
function listening(port, ms, ceiling) {
  return new Promise((resolve) => {
    const probe = probeTimeout(Math.max(1, ms), ceiling);
    const socket = connect(port, "127.0.0.1");
    const settle = (answer) => {
      probe.done();
      socket.destroy();
      resolve(answer);
    };
    probe.signal.addEventListener("abort", () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", (/** @type {NodeJS.ErrnoException} */ error) =>
      settle(error.code !== "ECONNREFUSED"),
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
export async function refusingServer(stateDir, ceiling) {
  const record = readJson(join(stateDir, "server.json"));
  if (!Number.isInteger(record?.port) || !recordHolds(record, null)) return null;
  const probe = probeTimeout(1500, ceiling);
  try {
    const challenge = randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${record.port}/health?challenge=${challenge}`, {
      signal: probe.signal,
    });
    const status = /** @type {any} */ (await res.json());
    return status?.app === name && recordHolds(record, status) ? record : null;
  } catch (error) {
    const busy = error.name === "TimeoutError" || error.name === "AbortError";
    return busy ? record : null;
  } finally {
    probe.done();
  }
}

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
  // Named as the daemon, because "it exited 0" was read as the CLI's own exit status.
  const state =
    child.exitCode === null
      ? "the daemon it started is still starting"
      : child.exitCode === 0
        ? "the daemon it started stepped aside for one that never answered"
        : `the daemon it started exited ${child.exitCode}`;
  // A start still going when the open gave up is not lost: the next open finds it once it is up.
  const next = child.exitCode === null ? "; a later open uses it once it is up" : "";
  return (
    `server did not start: ${state} after ${elapsedMs} ms and ${probes} probes${next}. ` +
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
