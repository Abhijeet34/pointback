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
 * not answer within CONNECT_MS of this process's running time (or PROBE_CEILING_MS of wall time)
 * because its event loop is busy. Both are checked because each alone can be reused by something
 * else after a crash; a pid whose port belongs to nothing, to another app, or to another daemon, is
 * a dead holder whose pid came back. Until it has a port, a holder is given STARTING_MS. Node has no
 * portable flock, and a socket file lock would leave a stale file behind on POSIX and be refused by
 * sandboxes that deny AF_UNIX.
 */
const LOCK_NAME = /^daemon\.(\d+)\.lock$/;
export const STARTING_MS = 10_000;
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
 * The timeout of a loopback probe whose expiry reads as a busy server. The verdict comes from the time
 * this process was running. A peer in another process keeps answering while this process is stalled;
 * what the stall prevents is this process reading that answer, so the expired timer must not count the
 * stall. A gap longer than a slice counts as one slice, and the abort waits one turn of the event loop,
 * so an answer or refusal read during the stall is read first. Under sustained starvation that running
 * time accrues slowly, so PROBE_CEILING_MS of wall time bounds the probe as well. It sits above the
 * longest stall measured, 11670 ms (windows-2025 hunt 37349003233, job 111894797244), so a stall alone
 * never reaches it; only starvation that outlasts it does.
 */
const PROBE_SLICE_MS = 50;
const PROBE_CEILING_MS = 20_000;

export function probeTimeout(ms, ceiling = PROBE_CEILING_MS) {
  const controller = new AbortController();
  const started = performance.now();
  let running = 0;
  let last = started;
  const timer = setInterval(() => {
    const now = performance.now();
    running += Math.min(now - last, PROBE_SLICE_MS);
    last = now;
    if (running < ms && now - started < ceiling) return;
    clearInterval(timer);
    setImmediate(() => controller.abort(new DOMException("the probe timed out", "TimeoutError")));
  }, PROBE_SLICE_MS);
  timer.unref();
  return { signal: controller.signal, done: () => clearInterval(timer) };
}

/**
 * Whether the port holds the daemon `pid`. Nothing listening, or a listener answering as another app
 * or for another pid, is not it; a daemon too busy to answer within CONNECT_MS of running time is, so
 * a timeout counts as alive.
 */
async function isDaemon(port, pid, ceiling) {
  const probe = probeTimeout(CONNECT_MS, ceiling);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: probe.signal });
    const status = /** @type {any} */ (await res.json());
    return status?.app === name && status.pid === pid;
  } catch (error) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  } finally {
    probe.done();
  }
}

/**
 * "live", "dead", or "gone" when the file vanished under the read and the scan must be redone, when
 * the lock was last written, wherever that could be read, and when its holder was stopped, if it was.
 */
async function holder(stateDir, generation, ceiling) {
  let held;
  let wroteAt;
  try {
    wroteAt = statSync(lockPath(stateDir, generation)).mtimeMs;
    held = readFileSync(lockPath(stateDir, generation), "utf8");
  } catch (error) {
    return { state: error.code === "ENOENT" ? "gone" : "live", wroteAt };
  }
  const starting = { state: Date.now() - wroteAt < STARTING_MS ? "live" : "dead", wroteAt };
  let parsed;
  try {
    parsed = JSON.parse(held);
  } catch {
    // Created and not yet written, or written by a start that died in between.
    return starting;
  }
  const { stoppedAt } = parsed;
  if (parsed.released || !Number.isInteger(parsed.pid) || !pidAlive(parsed.pid))
    return { state: "dead", wroteAt, stoppedAt };
  if (!Number.isInteger(parsed.port)) return starting;
  const live = await isDaemon(parsed.port, parsed.pid, ceiling);
  return { state: live ? "live" : "dead", wroteAt, stoppedAt };
}

/**
 * When the live daemon holding the state directory, started or still starting, last wrote its lock
 * (its claim, then its port), or null when none holds it. The time is undefined when it could not be
 * read. A holder with no port yet is live for STARTING_MS from that time, and no longer. `ceiling`
 * caps the wall time of the look at its port.
 */
export async function daemonHolds(stateDir, ceiling) {
  const top = generations(stateDir)[0];
  if (top === undefined) return null;
  const { state, wroteAt } = await holder(stateDir, top, ceiling);
  return state === "live" ? { wroteAt } : null;
}

/**
 * Claims the state directory for this process, or returns null when a live daemon holds it, or when
 * its holder was stopped after this process began (`begunAt`): a start spawned before a stop and still
 * booting through it would otherwise revive the directory the stop freed. The claim is published with
 * the port once bound, which re-checks that a takeover did not happen while this start was stalled; a
 * claim that lost says so and clears its own file.
 */
export async function claimDaemon(stateDir, begunAt = performance.timeOrigin) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const top = generations(stateDir)[0] ?? 0;
    if (top > 0) {
      const { state, stoppedAt } = await holder(stateDir, top);
      if (state === "live") return null;
      if (state === "gone") continue;
      // A stop stamped later than now, by a clock set back since, is not one this start began before.
      if (stoppedAt >= begunAt && stoppedAt <= Date.now()) return null;
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
  let port = null;
  const write = (fields) =>
    writeJsonAtomic(lockPath(stateDir, generation), { pid: process.pid, port, ...fields });
  const held = () => generations(stateDir)[0] === generation;
  return {
    /** Records the bound port; false when another daemon has taken over since the claim. */
    publish(bound) {
      port = bound;
      write({});
      if (held()) return true;
      remove(stateDir, generation);
      return false;
    },
    /**
     * Records that this daemon was asked to stop. The port stays named, so the directory is still held
     * until this process exits and a start meanwhile comes back on the port once it is free.
     */
    stopped() {
      try {
        if (held()) write({ stoppedAt: Date.now() });
      } catch {
        // A stop never fails on its record; without it a start still booting may claim after.
      }
    },
    /** Lets the next start take over at once, without waiting on this process to exit. */
    release() {
      try {
        if (held()) write({ port: null, released: true });
      } catch {
        // Only a speedup: where the write fails, as in a removed state directory, the next start
        // takes over once this pid is gone, so a close never fails on it.
      }
    },
  };
}
