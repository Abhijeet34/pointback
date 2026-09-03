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

test("the package cannot be published until the name is settled", () => {
  assert.equal(pkg.private, true);
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
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const files = pack.files.map((f) => f.path).sort();
  for (const file of files) {
    assert.match(
      file,
      /^(bin\/|src\/|README\.md$|THIRD-PARTY-NOTICES\.md$|package\.json$)/,
      `${file} is outside the allowlist`,
    );
  }
  assert.ok(files.includes(`bin/${name}.js`));
  assert.ok(files.includes("src/browser/sdk.js"));
  assert.ok(!files.some((f) => f.startsWith("test/")));
});
