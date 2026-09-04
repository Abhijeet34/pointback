import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { env, stateDirName } from "./identity.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const windows = process.platform === "win32";
/** Directories whose Windows ACL this process has already reset; see `restrictDir`. */
const restrictedDirs = new Set();

/** Runs icacls and returns its output; a non-zero exit throws, which is the point. */
function icacls(args) {
  return execFileSync("icacls", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The principals holding an ACE of the path's own, never one it inherits. icacls prints the
 * path on the first line and one `PRINCIPAL:(perms)` per line after it, marking an inherited
 * entry `(I)`; the inherited ones need no removing because `/inheritance:r` drops them all.
 */
function explicitPrincipals(path) {
  const names = [];
  for (const line of icacls([path]).split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("Successfully processed")) continue;
    const body = line.startsWith(path) ? line.slice(path.length) : line;
    const match = body.match(/^\s*(.+?):(\(.*)$/);
    if (match && !match[2].includes("(I)")) names.push(match[1]);
  }
  return names;
}

/**
 * Makes a directory reachable by nothing but the user running this process, and every file
 * created inside it likewise. POSIX says that in the mode bits. Windows has no such bits, so
 * every entry is cleared and one full-control entry for this user is granted with (OI)(CI),
 * which every file created inside then inherits - including the temp file `writeJsonAtomic`
 * renames into place, because a rename carries the file's own ACL.
 *
 * Both halves are load-bearing and neither covers the other: `/inheritance:r` drops what a
 * permissive parent lends, and the removal pass drops what is written on the directory
 * itself. A directory created by an administrator carries SYSTEM and BUILTIN\Administrators
 * as its own explicit entries, not as inherited ones, which is how a first attempt at this
 * left three principals on a directory it had just been asked to restrict to one. This user
 * is never in the removal list, so there is no moment where the process cannot reach it.
 *
 * A failure throws rather than warns: the state directory holds the server token, and a
 * directory that could not be restricted is one the token must not be written into.
 */
function restrictDir(dir, { onceOnly = false } = {}) {
  if (!windows) {
    chmodSync(dir, DIR_MODE);
    return;
  }
  if (onceOnly && restrictedDirs.has(dir)) return;
  const me = userInfo().username;
  const foreign = explicitPrincipals(dir).filter(
    (p) => p.split("\\").pop().toLowerCase() !== me.toLowerCase(),
  );
  if (foreign.length > 0) icacls([dir, ...foreign.flatMap((p) => ["/remove:g", p])]);
  icacls([dir, "/inheritance:r", "/grant:r", `${me}:(OI)(CI)F`]);
  restrictedDirs.add(dir);
}

/** The state directory, created private to the user; the env override serves tests and isolation. */
export function stateDir(environment = process.env) {
  const dir = env("STATE_DIR", environment) ?? join(homedir(), stateDirName);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir honours the mode only on creation, so an older or foreign directory is re-tightened.
  restrictDir(dir);
  return dir;
}

/**
 * The errors Windows raises when another process merely has the file open. A replace-rename is
 * refused while any reader holds the destination, and this daemon's own CLI polls `server.json`
 * every 50 ms while waiting for the daemon to come up - which is how run 33877405478, attempt 6,
 * ended with the daemon exiting 1 on `rename` into `server.json` and the CLI reporting a server
 * that would not start. The collision lasts as long as one read, so it is waited out.
 */
const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const SHARING_ATTEMPTS = 10;
const SHARING_PAUSE_MS = 25;

/** A synchronous pause, because the write this guards is synchronous and its callers rely on that. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `action`, retrying only the errors a concurrent reader on Windows can cause and rethrowing
 * everything else at once: a directory that is genuinely not writable must fail now, not in a
 * quarter of a second.
 */
export function pastSharingViolations(
  action,
  { attempts = SHARING_ATTEMPTS, pauseMs = SHARING_PAUSE_MS } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= attempts || !SHARING_ERRORS.has(error.code)) throw error;
      pause(pauseMs);
    }
  }
}

/** Writes through a sibling temp file and a rename, so a reader never sees a torn file. */
export function writeJsonAtomic(file, value) {
  // A new file's protection comes from a different place on each platform: on Windows it is
  // inherited from the directory, so the directory is restricted before the file exists, once
  // per process because an ACL children inherit is not something each write reapplies. On
  // POSIX it is the file's own mode, which every write sets.
  if (windows) restrictDir(dirname(file), { onceOnly: true });
  const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: FILE_MODE });
  if (!windows) chmodSync(tmp, FILE_MODE);
  pastSharingViolations(() => renameSync(tmp, file));
}

/** Parses a JSON file; a missing or unreadable file reads as `fallback` rather than throwing. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const CURSOR_FILE = "poll-cursor.json";

/**
 * The highest note uid this client has received for a file, so the next poll can acknowledge it and
 * the server can stop redelivering. Client-side state: a wrong or missing cursor only costs a safe
 * redelivery, never a lost note, so it need not be durable beyond best effort.
 */
export function readPollCursor(dir, file) {
  const value = readJson(join(dir, CURSOR_FILE), {})?.[file];
  return typeof value === "number" ? value : undefined;
}

export function writePollCursor(dir, file, uid) {
  const path = join(dir, CURSOR_FILE);
  const all = readJson(path, {});
  const next = { ...(all && typeof all === "object" ? all : {}) };
  // A computed key sets an own property (never the prototype), and `file` is always an absolute path.
  next[file] = uid;
  writeJsonAtomic(path, next);
}
