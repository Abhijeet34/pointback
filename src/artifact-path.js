import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const KEY_PATTERN = /^[0-9a-f]{16}$/;
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Resolves symlinks so two spellings of one file share a session. `realpathSync.native` and
 * not the JavaScript one: on Windows only the native call expands an 8.3 short name, so
 * C:\Users\RUNNER~1\... and C:\Users\runneradmin\... are one session rather than two, and the
 * directory watch on the result is a path Windows will report events under.
 */
export function canonicalFile(file) {
  return realpathSync.native(resolve(file));
}

/** A lookup key, never a credential: sixteen hex characters of the canonical path's hash. */
export function sessionKey(canonicalPath) {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

/**
 * Maps a request path under the artifact root to a real file inside it, or null.
 * Rejects before touching the filesystem anything that could name a parent, an
 * absolute location, a different separator, a null byte, or a lookalike that a
 * compatibility normalisation would turn into one of those.
 */
export function resolveAsset(rootDir, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    const folded = segment.normalize("NFKC");
    if (folded.includes("/") || folded.includes("\\") || folded === ".." || folded === ".") {
      return null;
    }
  }
  const candidate = join(rootDir, ...segments);
  if (isOutside(rootDir, candidate)) return null;
  let realRoot, realCandidate;
  try {
    realRoot = realpathSync.native(rootDir);
    realCandidate = realpathSync.native(candidate);
  } catch {
    return null;
  }
  // A symlink inside the root that points outside resolves outside; that is the escape.
  if (isOutside(realRoot, realCandidate)) return null;
  if (!statSync(realCandidate).isFile()) return null;
  return realCandidate;
}

function isOutside(root, target) {
  const rel = relative(root, target);
  return rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(target) !== target;
}
