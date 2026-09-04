// The state directory holds the server token and every session key, so nothing but its owner
// may read it. That property is one thing; the operating system's way of saying it is two, so
// the assertion below is over the property and only the reading of it is per platform.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { userInfo } from "node:os";

const windows = process.platform === "win32";

/**
 * Every principal `icacls` grants the path, as bare lowercase account names. Its output puts
 * the path on the first line and one `PRINCIPAL:(perms)` per line after it, so the principal
 * is whatever precedes the first `:(` once the echoed path is off the front.
 */
function principals(path) {
  const output = execFileSync("icacls", [path], { encoding: "utf8" });
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("Successfully processed")) continue;
    const body = line.startsWith(path) ? line.slice(path.length) : line;
    const match = body.match(/^\s*(.+?):\(/);
    if (match) names.push(match[1].split("\\").pop().toLowerCase());
  }
  return names;
}

/** True when nothing but the user running this process can reach the path. */
export function ownerOnly(path) {
  if (!windows) return (statSync(path).mode & 0o077) === 0;
  const names = new Set(principals(path));
  return names.size === 1 && names.has(userInfo().username.toLowerCase());
}

/** What the platform says about the path, for a failure message that names the actual state. */
function describe(path) {
  return windows
    ? execFileSync("icacls", [path], { encoding: "utf8" }).trim()
    : `mode ${(statSync(path).mode & 0o777).toString(8)}`;
}

/**
 * Asserts the path is the owner's alone. `posixMode` pins the exact bits where there are
 * bits, so the POSIX assertion stays as strict as it was before Windows had an answer.
 */
export function assertPrivate(path, posixMode) {
  if (!windows) assert.equal(statSync(path).mode & 0o777, posixMode, path);
  assert.ok(ownerOnly(path), `${path} is reachable by more than its owner: ${describe(path)}`);
}

/**
 * Opens the path to a principal that is not this user, so a test of re-tightening has
 * something to undo. S-1-5-32-545 is BUILTIN\\Users, which exists on every Windows.
 */
export function loosen(path) {
  if (!windows) return chmodSync(path, 0o755);
  execFileSync("icacls", [path, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdio: "pipe" });
}
