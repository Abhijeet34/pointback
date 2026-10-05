import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { name } from "./identity.js";
import { pastSharingViolations, writeJsonAtomic } from "./state-dir.js";

/**
 * One daemon per state directory. The lock is the highest-numbered `daemon.<n>.lock`, and a start
 * claims the next number with an exclusive create, which exactly one contender can win: two starts
 * that both find a dead holder cannot both replace it, which they could if replacing meant deleting
 * one file and creating it again. Generations below the holder's are litter the holder clears.
 *
 * A holder is alive while its pid is and its port answers as this app with that same pid, or does
 * not answer within CONNECT_MS because its event loop is busy. Both are checked because each alone
 * can be reused by something else after a crash; a pid whose port belongs to nothing, to another
 * app, or to another daemon, is a dead holder whose pid came back. Until it has a port, a holder is
 * given STARTING_MS. Node has no portable flock, and a socket file lock would leave a stale file
 * behind on POSIX and be refused by sandboxes that deny AF_UNIX.
 */
const LOCK_NAME = /^daemon\.(\d+)\.lock$/;
const STARTING_MS = 10_000;
const CONNECT_MS = 1_000;
const CLAIM_ATTEMPTS = 50;

const lockPath = (stateDir, generation) => join(stateDir, `daemon.${generation}.lock`);

/** Every generation on disk, highest first. */
function generations(stateDir) {
  return readdirSync(stateDir)
    .map((name) => Number(name.match(LOCK_NAME)?.[1]))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .sort((a, b) => b - a);
}

function remove(stateDir, generation) {
  pastSharingViolations(() => rmSync(lockPath(stateDir, generation), { force: true }));
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process that exists and belongs to someone else.
    return error.code === "EPERM";
  }
}

/**
 * The signal for a probe whose timeout reads as a busy server. A timer that fires late, because this
 * process was stalled, runs before the I/O it guards is read, so the abort waits one turn of the
 * event loop: a refusal or an answer that arrived during the stall is read first, and wins.
 */
export function probeTimeout(ms) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("the probe timed out", "TimeoutError"));
  setTimeout(() => setImmediate(abort), ms).unref();
  return controller.signal;
}

/**
 * Whether the port holds the daemon `pid`. Nothing listening, or a listener answering as another app
 * or for another pid, is not it; a daemon too busy to answer within CONNECT_MS is, so a timeout
 * counts as alive.
 */
async function isDaemon(port, pid) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: probeTimeout(CONNECT_MS),
    });
    const status = /** @type {any} */ (await res.json());
    return status?.app === name && status.pid === pid;
  } catch (error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
}

/** "live", "dead", or "gone" when the file vanished under the read and the scan must be redone. */
async function holder(stateDir, generation) {
  let held;
  let age;
  try {
    age = Date.now() - statSync(lockPath(stateDir, generation)).mtimeMs;
    held = readFileSync(lockPath(stateDir, generation), "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? "gone" : "live";
  }
  let parsed;
  try {
    parsed = JSON.parse(held);
  } catch {
    // Created and not yet written, or written by a start that died in between.
    return age < STARTING_MS ? "live" : "dead";
  }
  if (parsed.released || !Number.isInteger(parsed.pid) || !pidAlive(parsed.pid)) return "dead";
  if (!Number.isInteger(parsed.port)) return age < STARTING_MS ? "live" : "dead";
  return (await isDaemon(parsed.port, parsed.pid)) ? "live" : "dead";
}

/** Whether a live daemon, started or still starting, holds the state directory. */
export async function daemonHolds(stateDir) {
  const top = generations(stateDir)[0];
  return top !== undefined && (await holder(stateDir, top)) === "live";
}

/**
 * Claims the state directory for this process, or returns null when a live daemon holds it. The
 * claim is published with the port once bound, which re-checks that a takeover did not happen
 * while this start was stalled; a claim that lost says so and clears its own file.
 */
export async function claimDaemon(stateDir) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const top = generations(stateDir)[0] ?? 0;
    if (top > 0) {
      const state = await holder(stateDir, top);
      if (state === "live") return null;
      if (state === "gone") continue;
    }
    const mine = top + 1;
    try {
      writeFileSync(lockPath(stateDir, mine), JSON.stringify({ pid: process.pid, port: null }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    // A number below the top can be free again because its holder's successor cleared it.
    if (generations(stateDir)[0] !== mine) {
      remove(stateDir, mine);
      continue;
    }
    for (const older of generations(stateDir)) if (older < mine) remove(stateDir, older);
    return claim(stateDir, mine);
  }
  throw new Error(`could not claim ${stateDir}: it changed hands ${CLAIM_ATTEMPTS} times`);
}

function claim(stateDir, generation) {
  const write = (fields) =>
    writeJsonAtomic(lockPath(stateDir, generation), { pid: process.pid, ...fields });
  const held = () => generations(stateDir)[0] === generation;
  return {
    /** Records the bound port; false when another daemon has taken over since the claim. */
    publish(port) {
      write({ port });
      if (held()) return true;
      remove(stateDir, generation);
      return false;
    },
    /** Lets the next start take over at once, without waiting on this process to exit. */
    release() {
      if (held()) write({ port: null, released: true });
    },
  };
}
