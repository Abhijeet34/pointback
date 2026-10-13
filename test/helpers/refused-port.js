// Loaded into a daemon under test with --import: its bind to the port TEST_REFUSED_PORT fails with
// EACCES, as Windows refuses a bind to a port another account's socket, or an exclusive one, holds on
// the wildcard address. The CLI that loads it is left alone.
import net from "node:net";

if (process.argv[2] === "server") {
  const refused = Number(process.env.TEST_REFUSED_PORT);
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (port, ...rest) {
    if (port !== refused) return listen.call(this, port, ...rest);
    const error = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), {
      code: "EACCES",
      syscall: "listen",
    });
    process.nextTick(() => this.emit("error", error));
    return this;
  };
}
