// Loaded into a CLI under test with --import: every fetch gives up after TEST_FETCH_LIMIT_MS, the
// way Node's own fetch gives up on a response whose headers take over 300 s, scaled to a test.
const limit = Number(process.env.TEST_FETCH_LIMIT_MS);
const unlimited = globalThis.fetch;
globalThis.fetch = (url, options = {}) =>
  unlimited(url, {
    ...options,
    signal: AbortSignal.any([
      AbortSignal.timeout(limit),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
