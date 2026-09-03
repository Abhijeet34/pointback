import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEBOUNCE_MS, watchFile } from "../src/watch.js";

function lab() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-watch-"));
  const file = join(dir, "plan.html");
  writeFileSync(file, "<p>one</p>");
  return { dir, file };
}

/** fs.watch needs a moment after creation before the kernel delivers events for the path. */
const armed = () => sleep(150);

test("a burst of writes is one change, delivered after the debounce", async () => {
  const { file } = lab();
  const changes = [];
  const stop = watchFile(file, () => changes.push(Date.now()));
  await armed();
  const wroteAt = Date.now();
  for (let i = 0; i < 5; i += 1) writeFileSync(file, `<p>${i}</p>`);
  await sleep(DEBOUNCE_MS * 4);
  assert.equal(changes.length, 1, "five writes inside the window coalesce");
  const latency = changes[0] - wroteAt;
  assert.ok(latency >= DEBOUNCE_MS, `fired ${latency} ms after the write, before the window`);
  console.log(`watch: last write to change callback ${latency} ms (debounce ${DEBOUNCE_MS})`);
  stop();
});

test("a rename-replace save and a sibling's change are told apart", async () => {
  const { dir, file } = lab();
  let changes = 0;
  const stop = watchFile(file, () => (changes += 1));
  await armed();
  writeFileSync(join(dir, "other.css"), "p{}");
  await sleep(DEBOUNCE_MS * 3);
  assert.equal(changes, 0, "a sibling file is not the artifact");
  const tmp = join(dir, ".plan.html.tmp");
  writeFileSync(tmp, "<p>two</p>");
  renameSync(tmp, file);
  await sleep(DEBOUNCE_MS * 3);
  assert.equal(changes, 1, "the file replaced under the same name still counts");
  writeFileSync(file, "<p>three</p>");
  await sleep(DEBOUNCE_MS * 3);
  assert.equal(changes, 2, "and plain writes after the replace are still seen");
  stop();
});

test("a stopped watcher stays silent, and a vanished directory reports instead of throwing", async () => {
  const { dir, file } = lab();
  let changes = 0;
  const stop = watchFile(file, () => (changes += 1));
  await armed();
  stop();
  writeFileSync(file, "<p>after</p>");
  await sleep(DEBOUNCE_MS * 3);
  assert.equal(changes, 0);
  const errors = [];
  assert.throws(() => watchFile(join(dir, "missing", "x.html"), () => {}), /ENOENT/);
  const stopAgain = watchFile(file, () => {}, { onError: (e) => errors.push(e) });
  rmSync(dir, { recursive: true, force: true });
  await sleep(DEBOUNCE_MS * 3);
  stopAgain();
});
