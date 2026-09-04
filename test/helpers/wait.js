import { setTimeout as sleep } from "node:timers/promises";

/**
 * Waits for `read()` to answer with something truthy, bounded by a number of attempts as
 * well as by the clock, and names what it was waiting for when neither bound is met.
 *
 * The attempts half is the whole point of this helper. A budget written in milliseconds is
 * really a budget in however much the runner charges for one observation, and windows-2025
 * charges wildly: on run 33874545761, attempt 8, one `Runtime.evaluate` round trip took
 * about five seconds, so a 5000 ms wait dispatched exactly one mouse move and then reported
 * the pointer as never having reached the frame. A wait that has looked twenty times has
 * genuinely waited; a wait that has spent 5000 ms may not have looked at all. Raising the
 * millisecond budget would only move where that happens, so the fix is to stop expressing
 * patience in milliseconds alone.
 */
export async function until(
  read,
  { what, timeoutMs = 10_000, everyMs = 25, minAttempts = 20 } = {},
) {
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const value = await read();
    if (value) return value;
    const elapsed = Date.now() - started;
    if (attempts >= minAttempts && elapsed >= timeoutMs) {
      throw new Error(`timed out waiting for ${what}: ${attempts} attempts over ${elapsed} ms`);
    }
    await sleep(everyMs);
  }
}
