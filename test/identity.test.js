import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { env, envPrefix, name, stateDirName, version } from "../src/identity.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("everything named after the product derives from package.json", () => {
  assert.equal(name, pkg.name);
  assert.equal(version, pkg.version);
  assert.equal(envPrefix, `${name.toUpperCase()}_`);
  assert.equal(stateDirName, `.${name}`);
  assert.deepEqual(pkg.bin, { [name]: `bin/${name}.js` });
});

// The name was settled on 2026-09-03 and the repository is public, so the manifest
// no longer refuses a publish by itself. The switch that keeps publishing off is the
// NPM_PUBLISH_ENABLED repository variable, pinned by test/pipeline.test.js; what is
// left to guard here is that the metadata a publish would carry stays correct.
test("the manifest carries an SPDX licence with the licence text beside it", () => {
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.private, undefined);
  const license = readFileSync(new URL("LICENSE", root), "utf8");
  assert.match(license, /^ *Apache License\n *Version 2\.0, January 2004/m);
});

test("env reads only the prefixed variable and treats empty as unset", () => {
  assert.equal(env("PORT", { [`${envPrefix}PORT`]: "4000" }), "4000");
  assert.equal(env("PORT", { [`${envPrefix}PORT`]: "" }), undefined);
  assert.equal(env("PORT", { PORT: "4000" }), undefined);
});

test("the product name appears in src only inside identity.js", () => {
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "-l", "-i", name, "--", "src", ":!src/identity.js"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    // git grep exits 1 when nothing matches, which is the outcome this test wants.
    if (error.status !== 1) throw error;
  }
  assert.equal(hits, "", `name leaked into: ${hits}`);
});

test("a packed tarball ships only the allowlisted files", () => {
  const [pack] = JSON.parse(
    // npm is a .cmd on Windows, which Node refuses to spawn without a shell; the arguments
    // are constants, so cmd re-parsing them changes nothing.
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    }),
  );
  const files = pack.files.map((f) => f.path).sort();
  for (const file of files) {
    assert.match(
      file,
      /^(bin\/|src\/|LICENSE$|README\.md$|THIRD-PARTY-NOTICES\.md$|package\.json$)/,
      `${file} is outside the allowlist`,
    );
  }
  assert.ok(files.includes(`bin/${name}.js`));
  assert.ok(files.includes("src/browser/sdk.js"));
  // A published package without its licence file is a defect, and npm's own
  // implicit inclusion is not something to rely on: the allowlist names it.
  assert.ok(files.includes("LICENSE"));
  assert.ok(!files.some((f) => f.startsWith("test/")));
});
