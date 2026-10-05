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
 * Holds this process off its event loop for `ms` from the next tick, as a runner that deschedules it
 * does (windows-2025 hunt 37344599638, attempt 12: 9 s). Call it before the probe: the probe's socket
 * is seen on `net.client.socket`, and the stall throws unless that socket's connect is still in flight
 * when the loop blocks, so the refusal and the expired timer are both waiting at once.
 */
export function stallNextTick(ms) {
  let socket;
  const onSocket = (message) => {
    socket = message.socket;
  };
  subscribe("net.client.socket", onSocket);
  process.nextTick(() => {
    unsubscribe("net.client.socket", onSocket);
    if (!socket?.connecting) {
      throw new Error("stallNextTick: no connect was in flight when the loop blocked");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  });
}
