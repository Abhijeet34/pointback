// Loaded into a daemon under test with --import: it holds its whole start, before any of its own code
// runs, until the file TEST_BOOT_GATE exists, and its bind until TEST_BIND_GATE exists, each only when
// set, and writes its pid to `<gate>.reached` on arriving at one. A test opens a gate once what must
// come first has happened, so an order the timing would leave to chance is forced, and a gate never
// opened is a start that never comes up. The CLI that loads it is left alone.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";

if (process.argv[2] === "server") {
  const { TEST_BOOT_GATE: bootGate, TEST_BIND_GATE: bindGate } = process.env;
  const hold = (gate) => {
    // Renamed into place, so a reader that finds the file finds the pid: an empty read is pid 0, which
    // process.kill on Windows takes as the calling process (hunt job 114777032386).
    writeFileSync(`${gate}.reaching`, String(process.pid));
    renameSync(`${gate}.reaching`, `${gate}.reached`);
    while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  };
  if (bootGate) hold(bootGate);
  if (bindGate) {
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      hold(bindGate);
      return listen.apply(this, args);
    };
  }
}
