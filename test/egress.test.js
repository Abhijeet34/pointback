import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cli, fixture, isolatedEnv, presenceOf, sendNote } from "./helpers/env.js";
import { until } from "./helpers/wait.js";

const trap = new URL("./helpers/egress-trap.mjs", import.meta.url).href;
const lab = isolatedEnv();
const log = join(lab.dir, "egress.log");
writeFileSync(log, "");
lab.env.POINTBACK_EGRESS_LOG = log;
lab.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${trap}`.trim();
after(() => lab.stop());

test("the whole slice opens no connection that leaves the loopback interface", async () => {
  const opened = await cli([fixture], lab.env);
  assert.equal(opened.code, 0, opened.stderr);
  const key = opened.json().session.url.match(/session\/([0-9a-f]{16})/)[1];
  const info = lab.serverInfo();
  const polling = cli(["poll", fixture, "--timeout-ms", "10000"], lab.env);
  await until(async () => (await presenceOf(info, key)) === "listening", {
    what: "the poll to attach",
  });
  await sendNote(info, key, { prompt: "x", selector: "#t", tag: "h1", text: "t" });
  assert.equal((await polling).json().status, "feedback");
  await cli(["stop"], lab.env);

  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const connects = lines.filter((l) => l.includes(" connect "));
  const lookups = lines.filter((l) => l.includes(" lookup "));
  assert.ok(connects.length >= 3, `trap saw too little to be armed: ${lines.join("; ")}`);
  for (const line of connects)
    assert.match(line, / connect (127\.0\.0\.1|localhost|::1):\d+$/, line);
  for (const line of lookups) assert.match(line, / lookup (127\.0\.0\.1|localhost|::1)$/, line);
});
