import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { KEY_PATTERN, TOKEN_PATTERN, canonicalFile, sessionKey } from "./artifact-path.js";
import { HttpError } from "./http-guard.js";
import { limits } from "./limits.js";
import { readJson, writeJsonAtomic } from "./state-dir.js";

/**
 * Sessions live in a Map keyed by the path hash, so a key can only ever find a session
 * that was put there: no lookup reaches an inherited property. Every mutation is
 * written through to disk atomically, so a restarted server resumes where it stopped.
 */
export class SessionStore {
  #file;
  #sessions = new Map();
  #events = new EventEmitter();
  #activePolls = 0;

  constructor(file) {
    this.#file = file;
    const stored = readJson(file, { sessions: {} });
    for (const [key, session] of Object.entries(stored.sessions ?? {})) {
      if (KEY_PATTERN.test(key) && TOKEN_PATTERN.test(session?.assetToken ?? "")) {
        this.#sessions.set(key, session);
      }
    }
  }

  #persist() {
    writeJsonAtomic(this.#file, { sessions: Object.fromEntries(this.#sessions) });
  }

  /** Returns the session for a file, creating it on first sight. */
  open(file) {
    const canonical = canonicalFile(file);
    const key = sessionKey(canonical);
    let session = this.#sessions.get(key);
    if (!session) {
      if (this.#sessions.size >= limits.sessions) throw new HttpError(429, "too many sessions");
      session = {
        key,
        file: canonical,
        // A fresh secret per session gates the artifact bytes; the key alone opens nothing.
        assetToken: randomBytes(16).toString("hex"),
        nextUid: 1,
        pending: [],
        chat: [],
        createdAt: new Date().toISOString(),
      };
      this.#sessions.set(key, session);
      this.#persist();
    }
    return session;
  }

  get(key) {
    if (!KEY_PATTERN.test(key)) throw new HttpError(404, "no such session");
    const session = this.#sessions.get(key);
    if (!session) throw new HttpError(404, "no such session");
    return session;
  }

  keyFor(file) {
    return sessionKey(canonicalFile(file));
  }

  /** The chrome's view of a session: never the path-hash secret's siblings it does not need. */
  bootstrap(key) {
    const session = this.get(key);
    return {
      key,
      file: session.file,
      fileName: basename(session.file),
      artifactUrl: `/artifact/${key}/${session.assetToken}/${encodeURIComponent(basename(session.file))}`,
      chat: session.chat,
    };
  }

  queue(key, prompts) {
    const session = this.get(key);
    if (!Array.isArray(prompts) || prompts.length === 0)
      throw new HttpError(400, "prompts[] required");
    if (prompts.length > limits.promptsPerRequest)
      throw new HttpError(400, "too many prompts in one request");
    if (session.pending.length + prompts.length > limits.pendingPromptsPerSession) {
      throw new HttpError(429, "too many prompts waiting for the agent");
    }
    const at = new Date().toISOString();
    const accepted = prompts.map((raw) => {
      const prompt = validatePrompt(raw);
      return { uid: session.nextUid++, at, ...prompt };
    });
    session.pending.push(...accepted);
    for (const prompt of accepted) {
      session.chat.push({
        role: "user",
        uid: prompt.uid,
        at,
        prompt: prompt.prompt,
        target: targetOf(prompt),
      });
    }
    if (session.chat.length > limits.chatEntriesPerSession) {
      session.chat.splice(0, session.chat.length - limits.chatEntriesPerSession);
    }
    this.#persist();
    this.#events.emit(key);
    return { status: "queued", pending_prompts: session.pending.length };
  }

  /** Hands every waiting prompt to the agent exactly once. */
  take(key) {
    const session = this.get(key);
    const prompts = session.pending;
    session.pending = [];
    if (prompts.length > 0) this.#persist();
    return prompts;
  }

  /** Resolves with prompts as soon as any are waiting, or with null at the timeout. */
  waitForFeedback(key, timeoutMs, signal) {
    const immediate = this.take(key);
    if (immediate.length > 0) return Promise.resolve(immediate);
    if (this.#activePolls >= limits.concurrentPolls)
      throw new HttpError(429, "too many open polls");
    this.#activePolls += 1;
    return new Promise((resolve) => {
      const finish = (value) => {
        this.#activePolls -= 1;
        clearTimeout(timer);
        this.#events.off(key, onFeedback);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      // Two pollers race for one batch; the one that finds nothing keeps waiting.
      const onFeedback = () => {
        const prompts = this.take(key);
        if (prompts.length > 0) finish(prompts);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.#events.on(key, onFeedback);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function validatePrompt(raw) {
  if (raw === null || typeof raw !== "object") throw new HttpError(400, "prompt must be an object");
  const text = (field, max) => {
    const value = raw[field];
    if (typeof value !== "string") throw new HttpError(400, `prompt.${field} must be a string`);
    if (value.length > max) throw new HttpError(400, `prompt.${field} over ${max} characters`);
    return value;
  };
  const prompt = {
    prompt: text("prompt", limits.promptTextChars),
    selector: text("selector", 2000),
    tag: text("tag", 64),
    text: text("text", 2000),
  };
  if (prompt.prompt.trim() === "") throw new HttpError(400, "prompt.prompt is empty");
  return prompt;
}

function targetOf(prompt) {
  return { selector: prompt.selector, tag: prompt.tag, text: prompt.text };
}
