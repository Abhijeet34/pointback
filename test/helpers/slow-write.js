// Loaded into a daemon under test with --import, ahead of gated-start.js: a file it writes directly
// under TEST_SLOW_WRITE_DIR is created empty and left so until `<dir>/go` exists, with `<dir>/writing`
// saying the write is there. A busy windows-2025 runner held that gap open (hunt job 114777032386).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";

const dir = process.env.TEST_SLOW_WRITE_DIR;
if (process.argv[2] === "server" && dir) {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, data, options) => {
    if (typeof file !== "string" || dirname(file) !== dir) return write(file, data, options);
    write(file, "");
    write(join(dir, "writing"), "");
    while (!fs.existsSync(join(dir, "go"))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return write(file, data, options);
  };
  // gated-start.js imports writeFileSync by name, which reads the builtin's exports as synced here.
  syncBuiltinESMExports();
}
