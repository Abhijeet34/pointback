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
