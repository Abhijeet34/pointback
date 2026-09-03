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
 *
 * Agent presence is in memory only, because it describes live connections: `listening`
 * while a poll is attached, `working` after a poll took feedback until the next poll or the
 * bound in limits, and `waiting` otherwise. Every change to a session is emitted on its key.
 */
export class SessionStore {
  #file;
  #sessions = new Map();
  #events = new EventEmitter();
  #activePolls = 0;
  #pollsByKey = new Map();
  #working = new Map();

  constructor(file) {
    this.#file = file;
    this.#events.setMaxListeners(0);
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
        revision: 0,
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

  on(key, listener) {
    this.#events.on(key, listener);
  }

  off(key, listener) {
    this.#events.off(key, listener);
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
      ...this.status(key),
    };
  }

  /** What a freshly connected tab must know to be current: revision, presence and whether it ended. */
  status(key) {
    const session = this.get(key);
    return {
      revision: session.revision,
      presence: this.presence(key),
      ended: session.endedAt ? { by: session.endedBy, at: session.endedAt } : null,
    };
  }

  presence(key) {
    if (this.#pollsByKey.get(key) > 0) return { state: "listening" };
    const working = this.#working.get(key);
    if (working) return { state: "working", since: working.since };
    return { state: "waiting" };
  }

  queue(key, prompts) {
    const session = this.get(key);
    const accepted = this.#accept(session, prompts);
    this.#persist();
    this.#events.emit(key, { type: "feedback" });
    return { status: "queued", pending_prompts: session.pending.length, accepted };
  }

  #accept(session, prompts) {
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
    return accepted.length;
  }

  /** The file changed on disk: number the new state and tell every open tab. */
  bumpRevision(key) {
    const session = this.get(key);
    session.revision += 1;
    this.#persist();
    this.#events.emit(key, { type: "reload", revision: session.revision });
    return session.revision;
  }

  /**
   * Ends the review, queueing any last prompts in the same step so a send-and-end can never
   * strand them. `by` is who closed the loop: a user end refuses a plain reopen, an agent end does not.
   */
  end(key, by, prompts = []) {
    const session = this.get(key);
    const queued = prompts.length === 0 ? 0 : this.#accept(session, prompts);
    session.endedAt = new Date().toISOString();
    session.endedBy = by;
    this.#clearWorking(key);
    this.#persist();
    this.#events.emit(key, { type: "ended", by, queued });
    return { status: "ended", ended_by: by, queued };
  }

  /** Reopens an ended review, so a tab still showing the ended notice comes back to life. */
  reopen(key) {
    const session = this.get(key);
    if (!session.endedAt) return;
    delete session.endedAt;
    delete session.endedBy;
    this.#persist();
    this.#events.emit(key, { type: "reopened" });
  }

  /** Hands every waiting prompt to the agent exactly once. */
  take(key) {
    const session = this.get(key);
    const prompts = session.pending;
    session.pending = [];
    if (prompts.length > 0) this.#persist();
    return prompts;
  }

  /** The poll's answer when one exists now: feedback, or the ended notice; null means keep waiting. */
  #answer(key) {
    const session = this.get(key);
    const prompts = this.take(key);
    const ended = session.endedAt ? { ended_by: session.endedBy } : null;
    if (prompts.length > 0) {
      return { status: "feedback", prompts, ...(ended && { session_ended: true, ...ended }) };
    }
    return ended && { status: "ended", ...ended };
  }

  /** Resolves with the poll's answer, `waiting` at the timeout, or null when the caller went away. */
  waitForFeedback(key, timeoutMs, signal) {
    const immediate = this.#answer(key);
    if (immediate) {
      if (immediate.status === "feedback") this.#setWorking(key);
      return Promise.resolve(immediate);
    }
    if (this.#activePolls >= limits.concurrentPolls)
      throw new HttpError(429, "too many open polls");
    this.#activePolls += 1;
    this.#attach(key);
    return new Promise((resolve) => {
      const finish = (value) => {
        this.#activePolls -= 1;
        clearTimeout(timer);
        this.#events.off(key, onEvent);
        signal?.removeEventListener("abort", onAbort);
        this.#detach(key, value?.status === "feedback");
        resolve(value);
      };
      // Two pollers race for one batch; the one that finds nothing keeps waiting.
      const onEvent = (event) => {
        if (event.type !== "feedback" && event.type !== "ended") return;
        const answer = this.#answer(key);
        if (answer) finish(answer);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish({ status: "waiting" }), timeoutMs);
      this.#events.on(key, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #attach(key) {
    const before = this.presence(key).state;
    this.#pollsByKey.set(key, (this.#pollsByKey.get(key) ?? 0) + 1);
    this.#clearWorking(key);
    this.#announce(key, before);
  }

  #detach(key, delivered) {
    const before = this.presence(key).state;
    const left = this.#pollsByKey.get(key) - 1;
    if (left === 0) this.#pollsByKey.delete(key);
    else this.#pollsByKey.set(key, left);
    if (delivered) this.#setWorking(key, before);
    else this.#announce(key, before);
  }

  #setWorking(key, before = this.presence(key).state) {
    this.#clearWorking(key);
    // The final delivery of an ended session has no agent to wait for, so it leaves presence alone.
    if (this.get(key).endedAt) return this.#announce(key, before);
    const timer = setTimeout(() => {
      this.#working.delete(key);
      this.#announce(key, "working");
    }, limits.workingMaxMs);
    timer.unref();
    this.#working.set(key, { since: new Date().toISOString(), timer });
    this.#announce(key, before);
  }

  #clearWorking(key) {
    const working = this.#working.get(key);
    if (!working) return;
    clearTimeout(working.timer);
    this.#working.delete(key);
  }

  #announce(key, before) {
    const presence = this.presence(key);
    if (presence.state !== before) this.#events.emit(key, { type: "presence", ...presence });
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
