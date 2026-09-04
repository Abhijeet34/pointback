import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { env, stateDirName } from "./identity.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The state directory, created private to the user; the env override serves tests and isolation. */
export function stateDir(environment = process.env) {
  const dir = env("STATE_DIR", environment) ?? join(homedir(), stateDirName);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir honours the mode only on creation, so an older or foreign directory is re-tightened.
  chmodSync(dir, DIR_MODE);
  return dir;
}

/** Writes through a sibling temp file and a rename, so a reader never sees a torn file. */
export function writeJsonAtomic(file, value) {
  const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
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
