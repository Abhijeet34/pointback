import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { canonicalFile, resolveAsset, sessionKey } from "../src/artifact-path.js";

// A root with one legitimate sibling, one legitimate nested asset, a symlink that escapes,
// and a secret outside the root that every attack below tries to reach.
function lab() {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-path-"));
  const root = join(base, "site");
  mkdirSync(join(root, "img"), { recursive: true });
  writeFileSync(join(root, "plan.html"), "<p>plan</p>");
  writeFileSync(join(root, "style.css"), "p{}");
  writeFileSync(join(root, "img", "a.png"), "png");
  writeFileSync(join(base, "secret.txt"), "SECRET");
  symlinkSync(join(base, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(base, join(root, "up"));
  return { base, root };
}

/** The way a first attempt usually looks: decode, join, prefix-check. Every row below must beat it. */
function naiveResolve(root, requestPath) {
  const candidate = resolve(root, decodeURIComponent(requestPath));
  return candidate.startsWith(root) ? candidate : null;
}

const attacks = [
  ["plain parent", "../secret.txt"],
  ["double parent", "../../secret.txt"],
  ["nested then parent", "img/../../secret.txt"],
  ["encoded slash", "..%2fsecret.txt"],
  ["double-encoded slash", "..%252fsecret.txt"],
  ["encoded dots", "%2e%2e/secret.txt"],
  ["backslash", "..\\secret.txt"],
  ["encoded backslash", "..%5csecret.txt"],
  ["absolute path", "/etc/hosts"],
  ["absolute via empty segment", "//etc/hosts"],
  ["null byte", "style.css%00.txt"],
  ["fullwidth dots and slash (NFKC folds to ../)", "．．／secret.txt"],
  ["fullwidth solidus inside a segment", "img／..／..／secret.txt"],
  ["symlink to a file outside", "escape.txt"],
  ["symlink to a directory outside", "up/secret.txt"],
  ["directory instead of file", "img"],
  ["invalid percent encoding", "%zz"],
  ["dot segment", "./style.css"],
  ["root itself", ""],
];

test("the traversal matrix has teeth: a naive resolver lets most rows through", () => {
  const { root } = lab();
  let escaped = 0;
  for (const [, path] of attacks) {
    let result;
    try {
      result = naiveResolve(root, path);
    } catch {
      result = null;
    }
    if (result !== null && !result.startsWith(join(root, "img"))) escaped += 1;
    else if (result !== null) escaped += 1;
  }
  // The symlink rows, the absolute-path rows and the unicode rows all pass a prefix check.
  assert.ok(
    escaped >= 8,
    `naive resolver stopped too many rows (${escaped} escaped); matrix is weak`,
  );
});

test("the hardened resolver refuses every row of the matrix", () => {
  const { root } = lab();
  for (const [label, path] of attacks) {
    assert.equal(resolveAsset(root, path), null, label);
  }
});

test("the hardened resolver serves the legitimate paths, including through symlinked roots", () => {
  const { root, base } = lab();
  assert.equal(resolveAsset(root, "plan.html"), canonicalFile(join(root, "plan.html")));
  assert.equal(resolveAsset(root, "style.css"), canonicalFile(join(root, "style.css")));
  assert.equal(resolveAsset(root, "img/a.png"), canonicalFile(join(root, "img", "a.png")));
  assert.equal(resolveAsset(root, "img%2Fa.png"), canonicalFile(join(root, "img", "a.png")));
  symlinkSync(root, join(base, "alias"));
  assert.equal(
    resolveAsset(join(base, "alias"), "style.css"),
    canonicalFile(join(root, "style.css")),
  );
  assert.equal(resolveAsset(root, "missing.css"), null);
});

test("session keys are sixteen hex characters of the canonical path", () => {
  const { root } = lab();
  const key = sessionKey(canonicalFile(join(root, "plan.html")));
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(key, sessionKey(canonicalFile(join(root, "img", "..", "plan.html"))));
  assert.notEqual(key, sessionKey(canonicalFile(join(root, "style.css"))));
});
