// A test run killed midway runs none of its tests' cleanup, and a daemon a test started is detached
// by design, so it outlived the run (helpers/interrupt.js, docs/ENGINEERING-NOTES.md).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../src/daemon-lock.js";
import { until } from "./helpers/wait.js";

const killed = fileURLToPath(new URL("./fixtures/interrupted.js", import.meta.url));

test("a test run killed outright still stops the daemon its test started, and removes its state", async () => {
  const report = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-interrupt-")), "report");
  // Killed outright, the runner closes the pipe its file reports on, which every platform tells the
  // file on its next write; a signal it would pass on as SIGTERM ends a process at once on Windows.
  const env = { ...process.env, TEST_INTERRUPT_REPORT: report };
  // A run of its own: this file inherits NODE_TEST_CONTEXT, which makes a runner report as a child.
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, ["--test", killed], {
    env,
    stdio: "ignore",
  });
  let opened;
  try {
    opened = await until(
      () => {
        try {
          return JSON.parse(readFileSync(report, "utf8"));
        } catch {
          return null; // not written yet, or being written
        }
      },
      { what: "the test in the run to open its review", timeoutMs: 30_000 },
    );
    runner.kill("SIGKILL");
    const left = () => ({ daemon: pidAlive(opened.pid), state: existsSync(opened.dir) });
    await until(() => !left().daemon && !left().state, {
      what: "the killed run's daemon to stop and its state directory to go",
      timeoutMs: 30_000,
    }).catch(() => {});
    assert.deepEqual(left(), { daemon: false, state: false });
  } finally {
    runner.kill("SIGKILL");
    // Before this fix the killed file wrote on into the closed pipe and ran on, as did its daemon.
    for (const pid of [opened?.file, opened?.pid]) if (pid && pidAlive(pid)) process.kill(pid);
    if (opened) rmSync(opened.dir, { recursive: true, force: true });
    rmSync(join(report, ".."), { recursive: true, force: true });
  }
});
