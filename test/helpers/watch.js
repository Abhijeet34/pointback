// A restrictive sandbox lets `fs.watch` start and then fails it asynchronously with EMFILE, and
// `src/events.js` turns that failure into a `reload-off` line on the very stream that carries
// `superseded`. A test that reads the next line and asserts what it hoped for then reports the
// same result whether the behaviour it exists for works or is broken. Probing first lets each
// test say which path it is exercising and still assert the part that is testable either way.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFile } from "../../src/watch.js";

let probed;

/**
 * Whether file watching works on this machine, answered once per test process by watching a real
 * file with the product's own watcher. Only a write that comes back proves it: the absence of an
 * error proves nothing when the failure arrives on a later tick.
 */
export function watchAvailable(timeoutMs = 3000) {
  return (probed ??= probe(timeoutMs));
}

function probe(timeoutMs) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-watch-probe-"));
  const file = join(dir, "probe.html");
  writeFileSync(file, "<p>one</p>");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(write);
      unwatch();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // A watcher Windows has not finished releasing is not a verdict about watching.
      }
      resolve(available);
    };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    const unwatch = watchFile(file, () => finish(true), { onError: () => finish(false) });
    // A longer body, because two same-size writes inside one mtime tick are the one change
    // `watchFile` is documented to miss - the ceiling noted in src/watch.js.
    const write = setTimeout(() => writeFileSync(file, "<p>two, and longer</p>"), 20);
  });
}
