// Every test that touches the daemon gets its own state directory and an ephemeral port,
// so suites can run in parallel and never see the developer's real ~/.pointback.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const bin = fileURLToPath(new URL("../../bin/pointback.js", import.meta.url));
export const fixture = fileURLToPath(new URL("../fixtures/plan.html", import.meta.url));

export function isolatedEnv(extra = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-test-"));
  const env = {
    ...process.env,
    POINTBACK_STATE_DIR: dir,
    POINTBACK_PORT: "0",
    POINTBACK_NO_OPEN: "1",
    POINTBACK_IDLE_MS: "60000",
    ...extra,
  };
  return {
    dir,
    env,
    serverInfo: () => JSON.parse(readFileSync(join(dir, "server.json"), "utf8")),
    async stop() {
      await cli(["stop"], env).catch(() => {});
      // `stop` returning is the CLI exiting, not the daemon having let go of its state
      // directory, and Windows answers EPERM to a removal until it has. Same retry loop
      // and same reason as the browser profile in helpers/cdp.js.
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

/**
 * Runs the CLI as a real child process and resolves with its exit code and streams.
 * A command that never exits is killed and reported by name rather than waited on: an
 * unbounded wait on a child process is what turned a failing CI job into a 20-minute hang.
 */
export function cli(args, env, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the CLI did not exit within ${timeoutMs} ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}
