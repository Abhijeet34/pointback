// Loaded into a daemon under test with --import: it claims the state directory no sooner than
// TEST_CLAIM_AT_MS after its process started and binds its port no sooner than TEST_BIND_AT_MS, as a
// busy windows-2025 runner holds a start (hunt 37263767133, attempt 9). Each is a time to reach, not a
// pause added to the start, so time a slow runner already spent counts toward it: a fixed pause on top
// of a slow boot ran past the open's own 10 s before any claim (hunt 37358533578, attempts 6 and 18).
// The CLI that loads it is left alone.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

if (process.argv[2] === "server") {
  const left = (at) => performance.timeOrigin + Number(process.env[at]) - Date.now();
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    const wait = left("TEST_CLAIM_AT_MS");
    if (/daemon\.\d+\.lock$/.test(String(file)) && wait > 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    return writeFileSync.call(this, file, ...rest);
  };
  // The daemon imports writeFileSync by name, which sees the patch only once it is synced.
  syncBuiltinESMExports();
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    setTimeout(() => listen.apply(this, args), Math.max(0, left("TEST_BIND_AT_MS")));
    return this;
  };
}
