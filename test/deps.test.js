import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYERS, checkTree } from "../scripts/check-deps.js";

const src = new URL("../src/", import.meta.url).pathname;

test("the real tree has a stated direction and no cycles", () => {
  assert.deepEqual(checkTree(src), []);
  assert.equal(
    execFileSync(process.execPath, ["scripts/check-deps.js"], { encoding: "utf8" }).trim(),
    "dependency direction: ok",
  );
});

test("the checker catches a cycle, an upward import, and an unassigned module", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-deps-"));
  writeFileSync(join(dir, "a.js"), 'import "./b.js";\n');
  writeFileSync(join(dir, "b.js"), 'import { x } from "./c.js";\n');
  writeFileSync(join(dir, "c.js"), 'import "./a.js";\n');
  writeFileSync(join(dir, "stray.js"), "export const y = 1;\n");
  const problems = checkTree(dir, [["a.js"], ["b.js"], ["c.js"]]);
  assert.ok(
    problems.some((p) => p === "a.js imports b.js, which is not in a lower layer"),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => p.startsWith("cycle: a.js -> b.js -> c.js -> a.js")),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => p === "stray.js is not assigned to a layer"),
    problems.join("\n"),
  );
});

test("every source module is assigned to exactly one layer", () => {
  const assigned = LAYERS.flat();
  assert.equal(new Set(assigned).size, assigned.length);
});
