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

/**
 * Makes a directory reachable by nothing but the user running this process, and every file
 * created inside it likewise. POSIX says that in the mode bits. Windows has no such bits, so
 * the inherited entries are dropped and one full-control entry for this user is granted with
 * (OI)(CI), which every file created inside then inherits - including the temp file
 * `writeJsonAtomic` renames into place, because a rename carries the file's own ACL.
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
  execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${userInfo().username}:(OI)(CI)F`], {
    stdio: "pipe",
  });
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
  renameSync(tmp, file);
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
