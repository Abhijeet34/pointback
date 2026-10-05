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
    block(ms);
  });
}

/**
 * As stallNextTick, for a probe that is not issued yet when the stall is armed, such as one that
 * follows a response the test's own server sends: the stall lands on the tick after the next client
 * socket's connect, which is the probe's.
 */
export function stallOnConnect(ms) {
  const onSocket = ({ socket }) => {
    unsubscribe("net.client.socket", onSocket);
    process.nextTick(() => {
      if (!socket.connecting) {
        throw new Error("stallOnConnect: the connect had already settled when the loop blocked");
      }
      block(ms);
    });
  };
  subscribe("net.client.socket", onSocket);
}

function block(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
