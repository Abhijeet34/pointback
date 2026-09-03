// Every unbounded input has a ceiling here. Loopback narrows the attacker to a local
// process, but a local process can still exhaust memory or descriptors in a shared daemon.
export const limits = Object.freeze({
  requestBodyBytes: 256 * 1024,
  promptsPerRequest: 50,
  pendingPromptsPerSession: 200,
  chatEntriesPerSession: 1000,
  promptTextChars: 20_000,
  sessions: 64,
  concurrentPolls: 32,
  pollTimeoutDefaultMs: 60_000,
  pollTimeoutMaxMs: 600_000,
  idleShutdownMs: 30 * 60_000,
});
