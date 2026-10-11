// A restrictive sandbox lets `fs.watch` start and then fails it asynchronously with EMFILE, and
// `src/events.js` turns that failure into a `reload-off` line on the very stream that carries
// `superseded`. A test that reads the next line and asserts what it hoped for then reports the
// same result whether the behaviour it exists for works or is broken. Probing first lets each
// test say which path it is exercising and still assert the part that is testable either way.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEBOUNCE_MS, watchFile } from "../../src/watch.js";
import { until } from "./wait.js";

let probed;

/**
 * Whether file watching works on this machine, answered once per test process by watching a real
 * file with the product's own watcher. Only a write that comes back proves it: the absence of an
 * error proves nothing when the failure arrives on a later tick.
 *
 * Silence is a verdict only after many writes and `timeoutMs`, bounded like `until`: a starved
 * process loses a write made before its watcher arms, and one held off its loop past a clock-only
 * deadline reads its own stall as silence (docs/ENGINEERING-NOTES.md).
 */
export function watchAvailable(timeoutMs = 10_000) {
  return (probed ??= probe(timeoutMs));
}

async function probe(timeoutMs) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-watch-probe-"));
  const file = join(dir, "probe.html");
  writeFileSync(file, "<p></p>");
  let available;
  const unwatch = watchFile(file, () => (available ??= true), {
    onError: () => (available ??= false),
  });
  let writes = 0;
  const answered = () => {
    if (available !== undefined) return { available };
    // Each body longer than the last, because two same-size writes inside one mtime tick are the
    // one change `watchFile` is documented to miss - the ceiling noted in src/watch.js.
    writes += 1;
    writeFileSync(file, `<p>${"x".repeat(writes)}</p>`);
  };
  try {
    // Spaced past the debounce, so each write's change fires before the next can restart it.
    const what = "a write to the probe file to come back";
    const everyMs = DEBOUNCE_MS * 3;
    return (await until(answered, { what, timeoutMs, everyMs, minAttempts: 40 })).available;
  } catch {
    return false;
  } finally {
    unwatch();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // A watcher Windows has not finished releasing is not a verdict about watching.
    }
  }
}
