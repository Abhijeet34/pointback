import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer } from "node:net";

/** A loopback port that was just listening and no longer is, so a connect to it is refused. */
export async function closedPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Blocks the loop for `ms` on the tick after the next client socket's `connectionAttempt`, which Node
 * emits in `internalConnect` just before `connect(2)`. So the connect has gone out when the loop
 * blocks, and the refusal or answer is waiting behind the stall with the probe's expired timer.
 */
function armStall(ms) {
  let attempted = false;
  const onSocket = ({ socket }) => {
    unsubscribe("net.client.socket", onSocket);
    socket.once("connectionAttempt", () => {
      attempted = true;
      process.nextTick(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
    });
  };
  subscribe("net.client.socket", onSocket);
  return () => attempted;
}

/**
 * Holds this process off its event loop for `ms` as a runner that deschedules it does (windows-2025
 * hunt 37344599638, attempt 12: 9 s). Call it before the probe is issued: the stall throws at the
 * next turn unless the probe's connect was attempted, so a probe that never connects cannot pass.
 */
export function stallNextTick(ms) {
  const attempted = armStall(ms);
  setImmediate(() => {
    if (!attempted()) {
      throw new Error("stallNextTick: no connect was attempted, so the loop never blocked");
    }
  });
}

/**
 * As stallNextTick, for a probe that is not issued yet when the stall is armed, such as one that
 * follows a response the test's own server sends. The stall lands on the next client socket's connect,
 * which must be the probe's.
 */
export function stallOnConnect(ms) {
  armStall(ms);
}
