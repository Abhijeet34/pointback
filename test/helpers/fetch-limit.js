// Loaded into a CLI under test with --import: a poll request that asks the daemon to hold it past
// TEST_FETCH_LIMIT_MS fails the way Node's fetch fails a response whose headers take over 300 s,
// scaled to a test. It is decided from what the request asks for, never timed: a timed limit also
// failed requests the runner was merely slow to answer (run 37248292741, attempt 5).
// TEST_FETCH_LOG, when set, gets one line per poll request as its answer arrives.
import { appendFileSync } from "node:fs";

const limit = Number(process.env.TEST_FETCH_LIMIT_MS);
const log = process.env.TEST_FETCH_LOG;
const unlimited = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const held = new URL(url).searchParams.get("timeoutMs");
  if (Number(held) > limit) throw new TypeError("fetch failed");
  const response = await unlimited(url, options);
  if (log && held !== null) appendFileSync(log, `${held}\n`);
  return response;
};
