// A test file of its own, which test/interrupt.test.js runs and then kills: one test opens a review
// through the helpers and reports its daemon, then writes on a heartbeat, as a suite's reports do,
// until the kill.
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, fixture, isolatedEnv } from "../helpers/env.js";

test("a review is open when the run is killed", async () => {
  const own = isolatedEnv();
  await cli([fixture], own.env);
  const { pid } = own.serverInfo();
  const report = { dir: own.dir, pid, file: process.pid };
  writeFileSync(process.env.TEST_INTERRUPT_REPORT, JSON.stringify(report));
  for (;;) {
    console.log("still running");
    await sleep(50);
  }
});
