// Loaded into a daemon under test with --import: its start is held TEST_BOOT_HOLD_MS before it
// claims the state directory and TEST_BIND_HOLD_MS more between that claim and binding its port, as
// a busy windows-2025 runner holds a start (hunt 37263767133, attempt 9). The CLI is left alone.
import net from "node:net";

if (process.argv[2] === "server") {
  const hold = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  hold(Number(process.env.TEST_BOOT_HOLD_MS));
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    setTimeout(() => listen.apply(this, args), Number(process.env.TEST_BIND_HOLD_MS));
    return this;
  };
}
