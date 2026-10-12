// Loaded into the daemon and the `stop` under test with --import: the daemon asked to stop holds its
// exit until TEST_EXIT_GATE exists, so `stop` gives up on it at its deadline, and the look `stop` takes
// next opens the gate and waits for the exit, so the daemon goes in between, as a starved windows-2025
// runner ordered it (hunt job 114779896419).
import { subscribe } from "node:diagnostics_channel";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../../src/daemon-lock.js";

const gate = process.env.TEST_EXIT_GATE;
if (process.argv[2] === "server") {
  const exit = process.exit.bind(process);
  process.exit = (code) => {
    setInterval(() => existsSync(gate) && exit(code), 20);
  };
}
if (process.argv[2] === "stop") {
  let asked = false;
  subscribe("undici:request:create", ({ request }) => {
    if (request.method === "POST" && request.path === "/shutdown") asked = true;
    else if (asked && request.path.startsWith("/health")) {
      asked = false;
      const record = join(process.env.POINTBACK_STATE_DIR, "server.json");
      const { pid } = JSON.parse(readFileSync(record, "utf8"));
      writeFileSync(gate, "");
      while (pidAlive(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  });
}
