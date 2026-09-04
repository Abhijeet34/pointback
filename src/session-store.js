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

  /** Returns the session for a file, creating it on first sight and touching its recency. */
  open(file) {
    const canonical = canonicalFile(file);
    const key = sessionKey(canonical);
    const now = new Date().toISOString();
    let session = this.#sessions.get(key);
    if (!session) {
      if (this.#sessions.size >= limits.sessions) this.#evict();
      session = {
        key,
        file: canonical,
        // A fresh secret per session gates the artifact bytes; the key alone opens nothing.
        assetToken: randomBytes(16).toString("hex"),
        nextUid: 1,
        revision: 0,
        pending: [],
        chat: [],
        createdAt: now,
        lastActive: now,
      };
      this.#sessions.set(key, session);
    } else {
      session.lastActive = now;
    }
    this.#persist();
    return session;
  }

  /**
   * Makes room at the cap by disposing the least useful session, so a review is a bounded thing that
   * ends rather than an entry that accumulates until the tool wedges. An ended review goes before a
   * live one, and the longest-untouched before a recent one; a session with a poll attached right now
   * is never disposed, so an agent is never left polling a session that vanished. A session still
   * holding undelivered notes (queued or delivered-but-unacked) is never disposed either, so the
   * at-least-once delivery guarantee holds even under session-cap pressure. If every session is
   * carrying work, the cap is real work and the new open is refused.
   */
  #evict() {
    const evictable = [...this.#sessions.values()].filter(
      (s) => (this.#pollsByKey.get(s.key) ?? 0) === 0 && s.pending.length === 0 && !s.unacked,
    );
    if (evictable.length === 0) throw new HttpError(429, "too many active sessions");
    evictable.sort((a, b) => {
      if (Boolean(a.endedAt) !== Boolean(b.endedAt)) return a.endedAt ? -1 : 1;
      return (a.lastActive ?? a.createdAt).localeCompare(b.lastActive ?? b.createdAt);
    });
    const victim = evictable[0];
    this.#sessions.delete(victim.key);
    this.#clearWorking(victim.key);
  }

  get(key) {
    if (!KEY_PATTERN.test(key)) throw new HttpError(404, "no such session");
    const session = this.#sessions.get(key);
    if (!session) throw new HttpError(404, "no such session");
    return session;
  }

  /** How many sessions are held right now; bounded by `limits.sessions`. */
  get count() {
    return this.#sessions.size;
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

  queue(key, prompts, structure) {
    const session = this.get(key);
    const accepted = this.#accept(session, prompts, structure);
    this.#persist();
    this.#events.emit(key, { type: "feedback" });
    return { status: "queued", pending_prompts: session.pending.length, accepted };
  }

  #accept(session, prompts, structure) {
    if (!Array.isArray(prompts) || prompts.length === 0)
      throw new HttpError(400, "prompts[] required");
    if (prompts.length > limits.promptsPerRequest)
      throw new HttpError(400, "too many prompts in one request");
    if (session.pending.length + prompts.length > limits.pendingPromptsPerSession) {
      throw new HttpError(429, "too many prompts waiting for the agent");
    }
    const arrived = Date.now();
    session.lastActive = new Date(arrived).toISOString();
    const accepted = prompts.map((raw) => {
      const { at, ...prompt } = validatePrompt(raw);
      return { uid: session.nextUid++, at: noteTime(at, session, arrived), ...prompt };
    });
    // The outline describes the page these notes were written against, so it is replaced
    // with every batch rather than accumulated: an older one would describe a page that moved.
    if (structure !== undefined) session.structure = validateStructure(structure);
    session.pending.push(...accepted);
    for (const prompt of accepted) session.chat.push({ role: "user", ...prompt });
    if (session.chat.length > limits.chatEntriesPerSession) {
      session.chat.splice(0, session.chat.length - limits.chatEntriesPerSession);
    }
    return accepted.length;
  }

  /** The file changed on disk: number the new state and tell every open tab. */
  bumpRevision(key) {
    // A watcher can outlive its session by a beat if the session was evicted; then there is nothing
    // to renumber, so tolerate the gap rather than throwing inside the fs.watch callback.
    const session = this.#sessions.get(key);
    if (!session) return 0;
    session.revision += 1;
    this.#persist();
    this.#events.emit(key, { type: "reload", revision: session.revision });
    return session.revision;
  }

  /**
   * Ends the review, queueing any last prompts in the same step so a send-and-end can never
   * strand them. `by` is who closed the loop: a user end refuses a plain reopen, an agent end does not.
   */
  end(key, by, prompts = [], structure) {
    const session = this.get(key);
    const queued = prompts.length === 0 ? 0 : this.#accept(session, prompts, structure);
    // Who closed the loop is the first answer, not the last. An agent tidying up after the
    // reviewer already ended would otherwise relabel it as its own and, since only a user end
    // refuses a plain reopen, hand itself back a review the reviewer deliberately closed.
    if (!session.endedAt) {
      session.endedAt = new Date().toISOString();
      session.endedBy = by;
    }
    const endedBy = session.endedBy;
    this.#clearWorking(key);
    this.#persist();
    this.#events.emit(key, { type: "ended", by: endedBy, queued });
    return { status: "ended", ended_by: endedBy, queued };
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

  /** Drains the queue, clearing it as the batch leaves. Delivery goes through #answer, not this. */
  take(key) {
    const session = this.get(key);
    const prompts = session.pending;
    session.pending = [];
    if (prompts.length > 0) this.#persist();
    return prompts;
  }

  /**
   * The poll's answer when one exists now: feedback, or the ended notice; null means keep waiting.
   *
   * Delivery is at-least-once. A batch handed to a poll moves from `pending` to `unacked` and stays
   * there until a later poll's `ack` cursor reaches its high uid, so a poll whose response never
   * reached the agent redelivers the identical batch - same uids - rather than dropping it. The old
   * code cleared the queue the moment the answer was composed, which lost a batch whenever the
   * response did not arrive; a poll that took a batch and hit a dead socket is exactly that case.
   */
  #answer(key, ack, redeliver) {
    const session = this.get(key);
    // A poll whose cursor has reached the outstanding batch confirms it arrived; only then is it
    // cleared. A missing or stale cursor leaves the batch to be redelivered unchanged.
    if (session.unacked && ack !== undefined && ack >= session.unacked.receipt) {
      delete session.unacked;
      this.#persist();
    }
    const ended = session.endedAt ? { ended_by: session.endedBy } : null;
    // One batch is in flight at a time. A fresh poll (redeliver) re-sends the outstanding batch, so a
    // poll whose response was lost gets the identical notes - same uids, idempotent - not a drop. A
    // poll woken while another already holds that batch does not, so two pollers never split one
    // batch, and a newer batch waits behind the outstanding one, keeping the order the reviewer set.
    if (session.unacked) {
      if (!redeliver) return ended && { status: "ended", ...ended };
      const { prompts, structure, receipt } = session.unacked;
      return {
        status: "feedback",
        prompts,
        structure,
        receipt,
        ...(ended && { session_ended: true, ...ended }),
      };
    }
    if (session.pending.length > 0) {
      const prompts = session.pending;
      session.pending = [];
      const receipt = prompts[prompts.length - 1].uid;
      session.unacked = { prompts, structure: session.structure ?? "", receipt };
      this.#persist();
      return {
        status: "feedback",
        prompts,
        structure: session.unacked.structure,
        receipt,
        ...(ended && { session_ended: true, ...ended }),
      };
    }
    return ended && { status: "ended", ...ended };
  }

  /** Resolves with the poll's answer, `waiting` at the timeout, or null when the caller went away. */
  waitForFeedback(key, timeoutMs, signal, ack) {
    // A fresh poll may redeliver the outstanding batch; a poll woken by an event may not.
    const immediate = this.#answer(key, ack, true);
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
        const answer = this.#answer(key, ack, false);
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
    this.#clearWorking(key, false);
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
    this.#clearWorking(key, false);
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

  // Leaving working is announced by default: ending a review while the agent was working cleared
  // it silently, so the tab kept a disabled Send and a timer counting against an agent the server
  // had stopped waiting for, and only a page reload freed the reviewer. The callers that pass
  // `false` announce for themselves a line later, having the further state change to name.
  #clearWorking(key, announce = true) {
    const working = this.#working.get(key);
    if (!working) return;
    clearTimeout(working.timer);
    this.#working.delete(key);
    if (announce) this.#announce(key, "working");
  }

  #announce(key, before) {
    const presence = this.presence(key);
    if (presence.state !== before) this.#events.emit(key, { type: "presence", ...presence });
  }
}

/** A bounded string field, named by its owner so the 400 says which one was wrong. */
function str(object, owner, field, max) {
  const value = object[field];
  if (typeof value !== "string") throw new HttpError(400, `${owner}.${field} must be a string`);
  if (value.length > max) throw new HttpError(400, `${owner}.${field} over ${max} characters`);
  return value;
}

function validatePrompt(raw) {
  if (raw === null || typeof raw !== "object") throw new HttpError(400, "prompt must be an object");
  const prompt = {
    prompt: str(raw, "prompt", "prompt", limits.promptTextChars),
    selector: str(raw, "prompt", "selector", 2000),
    tag: str(raw, "prompt", "tag", 64),
    text: str(raw, "prompt", "text", 2000),
  };
  if (prompt.prompt.trim() === "") throw new HttpError(400, "prompt.prompt is empty");
  if (raw.at !== undefined) prompt.at = str(raw, "prompt", "at", 40);
  if (raw.target !== undefined) prompt.target = validateTarget(raw.target);
  return prompt;
}

/**
 * When the reviewer wrote the note. The chrome stamps it as the note is added, because one stamp
 * per batch loses the order and pace of a review that took ten minutes to write. That clock is
 * the reviewer's own on this machine, so it needs no trust beyond a sanity range: a value from
 * outside this session's life is unusable and falls back to the moment the batch arrived.
 */
function noteTime(at, session, arrived) {
  const written = Date.parse(at ?? "");
  const opened = Date.parse(session.createdAt);
  const usable = Number.isFinite(written) && written >= opened && written <= arrived;
  return new Date(usable ? written : arrived).toISOString();
}

/**
 * The target is how the agent finds the note again in a page it may have re-rendered,
 * so each shape is rebuilt field by field here: an unknown one is refused rather than
 * forwarded, and nothing the page invented rides along beside the fields named below.
 */
function validateTarget(raw) {
  if (raw === null || typeof raw !== "object") throw new HttpError(400, "target must be an object");
  if (raw.type === "text-range") {
    const offset = (field) => {
      const value = raw[field];
      if (!Number.isInteger(value) || value < 0)
        throw new HttpError(400, `target.${field} must be a non-negative integer`);
      return value;
    };
    const start = offset("start");
    const end = offset("end");
    if (end <= start) throw new HttpError(400, "target.end must be after target.start");
    return {
      type: "text-range",
      start,
      end,
      before: str(raw, "target", "before", 64),
      after: str(raw, "target", "after", 64),
    };
  }
  if (raw.type === "table-cell") {
    const cell = { type: "table-cell" };
    if (raw.row !== undefined) cell.row = str(raw, "target", "row", 200);
    if (raw.column !== undefined) cell.column = str(raw, "target", "column", 200);
    return cell;
  }
  throw new HttpError(400, "unknown target.type");
}

function validateStructure(raw) {
  if (typeof raw !== "string") throw new HttpError(400, "structure must be a string");
  if (raw.length > limits.structureChars)
    throw new HttpError(400, `structure over ${limits.structureChars} characters`);
  return raw;
}
