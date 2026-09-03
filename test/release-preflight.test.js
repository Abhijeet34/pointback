import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { preflight } from "../scripts/release-preflight.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const good = {
  tag: `v${pkg.version}`,
  tagCommit: "a".repeat(40),
  releaseCommit: "a".repeat(40),
  pkg,
  publishing: false,
};

test("a tag created by this run for this version passes", () => {
  assert.deepEqual(preflight(good), []);
});

test("a tag that existed before this run is refused", () => {
  const problems = preflight({ ...good, tagCommit: "b".repeat(40) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /existed before this run and must be deleted rather than reused/);
});

test("a tag that does not name the package version is refused", () => {
  assert.match(preflight({ ...good, tag: "v9.9.9" })[0], /does not name package.json's version/);
});

test("publishing is refused while the package is private, unlicensed or unallowlisted", () => {
  const problems = preflight({
    ...good,
    publishing: true,
    pkg: { version: pkg.version, private: true, license: "UNLICENSED" },
  });
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes('"private": true')));
  assert.ok(problems.some((p) => p.includes("license is UNLICENSED")));
  assert.ok(problems.some((p) => p.includes("no files allowlist")));
});

test("those three say nothing until publishing is actually enabled", () => {
  assert.deepEqual(preflight({ ...good, pkg: { version: pkg.version, private: true } }), []);
});

test("the script refuses a mismatch from the command line", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  // No tag exists in this tree, so HEAD stands in for one: the point under test
  // is that the CLI compares and exits non-zero, not how it resolves the name.
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["scripts/release-preflight.js", "--tag", "HEAD", "--commit", "c".repeat(40)],
        { cwd: root, encoding: "utf8", stdio: "pipe" },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, new RegExp(`points at ${head}`));
      return true;
    },
  );
});
