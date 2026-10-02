// Copies the house design system's colour ramps, roles and scales into src/browser/house/ and
// records the commit they came from, so the chrome's look is pinned to one reviewed upstream
// version. Byte-for-byte copies: test/house.test.js refuses a vendored file whose digest no
// longer matches the pin, so a hand edit here is drift and the fix is to change the house.
//
//   node scripts/sync-house.js ../halderworks-design
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { name } from "../src/identity.js";

export const SOURCE = "https://github.com/Abhijeet34/halderworks-design";
const houseDir = fileURLToPath(new URL("../src/browser/house/", import.meta.url));

/** Vendored name -> path in the house repository; the brand file is the product's own. */
export const FILES = {
  "brand.tokens.css": `ramps/tokens/${name}.tokens.css`,
  "roles.css": "ramps/roles.css",
  "scales.css": "ramps/scales.css",
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sync(checkout) {
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  // A pin names a commit anyone can fetch, so uncommitted ramps would pin bytes no commit has.
  if (git("status", "--porcelain", "--", "ramps").trim()) {
    throw new Error(`${checkout} has uncommitted changes under ramps/; commit or stash them first`);
  }
  const files = {};
  for (const [local, upstream] of Object.entries(FILES)) {
    const bytes = readFileSync(resolve(checkout, upstream));
    writeFileSync(resolve(houseDir, local), bytes);
    files[local] = { from: upstream, sha256: sha256(bytes) };
  }
  const pin = { source: SOURCE, commit: git("rev-parse", "HEAD").trim(), files };
  writeFileSync(resolve(houseDir, "pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout] = process.argv.slice(2);
  if (!checkout) {
    console.error("usage: node scripts/sync-house.js <halderworks-design checkout>");
    process.exit(2);
  }
  console.log(JSON.stringify(sync(resolve(checkout)), null, 2));
}
