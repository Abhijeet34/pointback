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
 * does (windows-2025 hunt 37344599638, attempt 12: 9 s). Called right after a probe is issued, the
 * probe's connect has gone out first, so its answer and its expired timer are both waiting at once.
 */
export function stallNextTick(ms) {
  process.nextTick(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
}
