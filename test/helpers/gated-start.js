// Loaded into a daemon under test with --import: it holds its claim of the state directory until the
// file TEST_CLAIM_GATE exists, and its bind until TEST_BIND_GATE exists, each only when set, and writes
// its pid to `<gate>.reached` on arriving at one. A test opens a gate once what must come first has
// happened, so an order the timing would leave to chance is forced. The CLI that loads it is left alone.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

if (process.argv[2] === "server") {
  const { TEST_CLAIM_GATE: claimGate, TEST_BIND_GATE: bindGate } = process.env;
  const { existsSync, writeFileSync } = fs;
  const hold = (gate) => {
    writeFileSync(`${gate}.reached`, String(process.pid));
    while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  };
  if (claimGate) {
    fs.writeFileSync = function (file, ...rest) {
      if (/daemon\.\d+\.lock$/.test(String(file))) hold(claimGate);
      return writeFileSync.call(this, file, ...rest);
    };
    // The daemon imports writeFileSync by name, which sees the patch only once it is synced.
    syncBuiltinESMExports();
  }
  if (bindGate) {
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      hold(bindGate);
      return listen.apply(this, args);
    };
  }
}
