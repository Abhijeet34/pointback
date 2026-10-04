import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  KEY_PATTERN,
  TOKEN_PATTERN,
  canonicalFile,
  canonicalPath,
  isOutside,
  sessionKey,
} from "./artifact-path.js";
import { HttpError } from "./http-guard.js";
import { limits } from "./limits.js";
import { assetsOutside } from "./inject.js";
import { MARKDOWN_STYLES, artifactKind, renderMarkdown } from "./markdown.js";
import {
  pastSharingViolations,
  privateDir,
  readJson,
  readPollCursor,
  writeJsonAtomic,
} from "./state-dir.js";

/**
 * Sessions live in a Map keyed by the path hash, so a key can only ever find a session
 * that was put there: no lookup reaches an inherited property. Every mutation writes its own
 * session's file through atomically, so a restarted server resumes where it stopped.
 *
 * A note the reviewer has added but not sent is a draft, kept on its session here rather than in
 * the tab, so closing the tab or restarting the daemon loses none of it; Send promotes every draft
 * to the agent's queue at once.
 *
 * Agent presence is in memory only, because it describes live connections: `listening`
 * while a poll is attached or within `limits.pollGraceMs` of one that ended with nothing,
 * `working` after a poll took feedback until the next poll or the bound in limits, and
 * `waiting` otherwise. Every change to a session is emitted on its key.
 */
export const EPOCH_PATTERN = /^[0-9a-f]{16}$/;
export const DRAFT_ID_PATTERN = /^[0-9a-f]{16}$/;
const newEpoch = () => randomBytes(8).toString("hex");
/** The one file every session lived in before each got its own. */
const LEGACY_FILE = "state.json";

export class SessionStore {
  #stateDir;
  #dir;
  #sessions = new Map();
  #events = new EventEmitter();
  #activePolls = 0;
  #pollsByKey = new Map();
  #lingering = new Map();
  #working = new Map();
  #live;

  /**
   * `stateDir` holds one file per session under `sessions/`, so a mutation rewrites only the session
   * it changed: a file save costs the same with one review held as with the cap. `live` says whether
   * a tab is showing a review right now (`EventStreams.live`), which keeps it from eviction.
   * @param {string} stateDir
   * @param {{ live?: (key: string) => boolean }} [options]
   */
  constructor(stateDir, { live = () => false } = {}) {
    this.#stateDir = stateDir;
    this.#live = live;
    this.#dir = privateDir(join(stateDir, "sessions"));
    this.#events.setMaxListeners(0);
    for (const name of readdirSync(this.#dir)) {
      const path = join(this.#dir, name);
      // A temp file is a write that died before its rename; the session file it was replacing is
      // still whole, so the temp is only litter, and it can be as large as the session.
      if (name.endsWith(".tmp")) rmSync(path, { force: true });
      else if (name.endsWith(".json")) this.#load(name.slice(0, -".json".length), readJson(path));
    }
    this.#split(join(stateDir, LEGACY_FILE));
  }

  /** Holds a stored session if it is well formed, upgrading what older versions did not record. */
  #load(key, session) {
    if (!KEY_PATTERN.test(key) || session?.key !== key) return false;
    if (!TOKEN_PATTERN.test(session.assetToken ?? "")) return false;
    let upgraded = false;
    // A session stored before epochs existed gets one now, and keeps it: without one, no
    // cursor could ever match it and its outstanding batch would be redelivered forever.
    if (!EPOCH_PATTERN.test(session.epoch ?? "")) {
      session.epoch = newEpoch();
      upgraded = true;
    }
    // A session stored before roots existed resolved its assets in the file's own folder.
    if (typeof session.root !== "string") {
      session.root = dirname(session.file);
      upgraded = true;
    }
    this.#sessions.set(key, session);
    if (upgraded) this.#persist(session);
    return true;
  }

  /**
   * Splits the single `state.json` every earlier version kept into one file per session. Its copy
   * wins over a session file already there, which only an interrupted split or a downgrade leaves.
   * The old file is renamed, never deleted, and only once every session reads back as written; until
   * then it stays where it is and the next start splits it again.
   */
  #split(legacy) {
    const stored = readJson(legacy);
    if (!stored) return;
    const moved = Object.entries(stored.sessions ?? {}).filter(([key, session]) =>
      this.#load(key, session),
    );
    for (const [, session] of moved) this.#persist(session);
    const lost = moved.filter(
      ([key]) => !isDeepStrictEqual(readJson(this.#path(key)), this.get(key)),
    );
    if (lost.length > 0)
      throw new Error(
        `${legacy} was not split cleanly (${lost.length} sessions); it is left in place`,
      );
    pastSharingViolations(() => renameSync(legacy, `${legacy}.migrated`));
  }

  #path(key) {
    return join(this.#dir, `${key}.json`);
  }

  #persist(session) {
    writeJsonAtomic(this.#path(session.key), session);
  }

  /**
   * Returns the session for a file, creating it on first sight and touching its recency. `root` is
   * the folder its assets resolve within, set by every open so the latest one is what is served.
   */
  open(file, root) {
    const canonical = canonicalFile(file);
    if (!artifactKind(canonical))
      throw new HttpError(
        415,
        `${basename(canonical)} cannot be reviewed: open an HTML (.html, .htm) or Markdown (.md, .markdown) file`,
      );
    const assets = assetRoot(root, canonical);
    const key = sessionKey(canonical);
    const now = new Date().toISOString();
    let session = this.#sessions.get(key);
    const rerooted = session !== undefined && session.root !== assets;
    if (!session) {
      if (this.#sessions.size >= limits.sessions) this.#evict();
      session = {
        key,
        file: canonical,
        root: assets,
        // A fresh secret per session gates the artifact bytes; the key alone opens nothing.
        assetToken: randomBytes(16).toString("hex"),
        // Names this life of the session: a poll cursor carried over from an evicted earlier life
        // must not acknowledge the new one's notes.
        epoch: newEpoch(),
        // Numbering goes on from the last uid the agent was handed for this file, so a uid never
        // repeats in a file's review history and an agent skipping uids it applied drops nothing.
        nextUid: (readPollCursor(this.#stateDir, canonical)?.uid ?? 0) + 1,
        revision: 0,
        pending: [],
        drafts: [],
        chat: [],
        createdAt: now,
        lastActive: now,
      };
      this.#sessions.set(key, session);
    } else {
      session.lastActive = now;
      session.root = assets;
    }
    this.#persist(session);
    // A tab already showing the review opens no second one, so it must follow the page to its new
    // address: the old one no longer resolves, and its next reload would paint a 404.
    if (rerooted)
      this.#events.emit(key, {
        type: "rerooted",
        artifactUrl: this.status(key).artifactUrl,
        outside: this.outside(key),
      });
    return session;
  }

  /**
   * Makes room at the cap by disposing the least useful session, so a review is a bounded thing that
   * ends rather than an entry that accumulates until the tool wedges. An ended review goes before a
   * running one, and the longest-untouched before a recent one; a session with a poll attached right
   * now, or within the grace of one, is never disposed, so an agent is never left polling a session
   * that vanished, and nor is one a tab is showing, which would be left unable to add a note while
   * the agent was told it was open.
   * A session still holding undelivered notes (queued or delivered-but-unacked) is never disposed
   * either, so the at-least-once delivery guarantee holds even under session-cap pressure, and nor is
   * one holding drafts the reviewer has not sent yet. If every session is carrying work, the cap is
   * real work and the new open is refused.
   */
  #evict() {
    const evictable = [...this.#sessions.values()].filter(
      (s) =>
        (this.#pollsByKey.get(s.key) ?? 0) === 0 &&
        !this.#live(s.key) &&
        s.pending.length === 0 &&
        !s.unacked &&
        !s.drafts?.length,
    );
    if (evictable.length === 0)
      throw new HttpError(
        429,
        `all ${limits.sessions} reviews held are open in a tab, being polled or holding notes, so none can make room: ask the reviewer to close the tab of a finished review, let a poll on a review run to the end or end that review, or for a review holding notes, poll it until a poll comes back with no new notes, or ask the reviewer to discard unsent notes, or to send them and then poll it that way (a review held for more than one of these needs each cleared)`,
      );
    evictable.sort((a, b) => {
      if (Boolean(a.endedAt) !== Boolean(b.endedAt)) return a.endedAt ? -1 : 1;
      return (a.lastActive ?? a.createdAt).localeCompare(b.lastActive ?? b.createdAt);
    });
    const victim = evictable[0];
    this.#sessions.delete(victim.key);
    rmSync(this.#path(victim.key), { force: true });
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

  /** The key for a path, even one whose file has since moved or been deleted. */
  keyFor(file) {
    return sessionKey(canonicalPath(file));
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
      ...this.status(key),
      outside: this.outside(key),
    };
  }

  /**
   * What the page loads from outside its root, which the review does not serve, so the agent and the
   * reviewer can be told why it looks unstyled rather than left to guess. Read from the file as it is.
   */
  outside(key) {
    const session = this.get(key);
    let source;
    try {
      source = readFileSync(session.file, "utf8");
    } catch {
      return [];
    }
    const markdown = artifactKind(session.file) === "markdown";
    const page = markdown ? renderMarkdown(source, session.file) : source;
    const { artifactUrl } = this.status(key);
    const rootUrl = `/artifact/${key}/${session.assetToken}/`;
    return assetsOutside(page, rootUrl, artifactUrl).filter(
      (ref) => !(markdown && MARKDOWN_STYLES.includes(ref)),
    );
  }

  /**
   * What a freshly connected tab must know to be current: revision, presence, whether it ended,
   * whether its file is gone, and the notes, sent with the agent's replies and unsent.
   */
  status(key) {
    const session = this.get(key);
    // The page's own address is its path under the root, so `../` in its markup climbs the root's
    // folders. It is part of status because a later open with another root moves it.
    const path = relative(session.root, session.file).split(sep).map(encodeURIComponent).join("/");
    return {
      artifactUrl: `/artifact/${key}/${session.assetToken}/${path}`,
      revision: session.revision,
      chat: session.chat,
      drafts: session.drafts ?? [],
      presence: this.presence(key),
      ended: session.endedAt ? { by: session.endedBy, at: session.endedAt } : null,
      gone: !existsSync(session.file),
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
    this.#persist(session);
    this.#events.emit(key, { type: "feedback" });
    return { status: "queued", pending_prompts: session.pending.length, accepted };
  }

  /**
   * Keeps a note the reviewer added, stamped now: the moment it was written is the moment it
   * reached the daemon. Capped at one send's worth, since Send promotes every draft as one batch.
   */
  addDraft(key, raw, structure) {
    const session = this.get(key);
    const drafts = session.drafts ?? [];
    if (drafts.length >= limits.promptsPerRequest)
      throw new HttpError(429, `${drafts.length} notes are waiting to be sent; send them first`);
    const note = validatePrompt(raw);
    delete note.at;
    // Source lines mean something only against the Markdown this server rendered them from.
    if (artifactKind(session.file) !== "markdown") delete note.lines;
    if (note.answers !== undefined && !session.chat.some((entry) => entry.uid === note.answers))
      throw new HttpError(400, `prompt.answers names no note in this review: ${note.answers}`);
    const outline = structure === undefined ? undefined : validateStructure(structure);
    drafts.push({ id: randomBytes(8).toString("hex"), ...note, at: new Date().toISOString() });
    if (outline !== undefined) session.draftStructure = outline;
    return this.#draftsChanged(session, drafts);
  }

  /** Removes one draft; removing one that is already gone is not an error, so a retry is safe. */
  removeDraft(key, id) {
    const session = this.get(key);
    return this.#draftsChanged(
      session,
      (session.drafts ?? []).filter((draft) => draft.id !== id),
    );
  }

  /**
   * Rewrites one draft's instruction in place, keeping its target, stamp and place in the batch.
   * A draft that is gone was sent or removed in another tab, which the reviewer is told.
   */
  editDraft(key, id, prompt) {
    const session = this.get(key);
    const drafts = session.drafts ?? [];
    const draft = drafts.find((entry) => entry.id === id);
    if (!draft) throw new HttpError(404, "that note was already sent or removed");
    draft.prompt = validatePrompt({ ...draft, prompt }).prompt;
    return this.#draftsChanged(session, drafts);
  }

  /** Send: every draft goes to the agent's queue as one batch, in the order it was written. */
  send(key) {
    const session = this.get(key);
    if (!session.drafts?.length) throw new HttpError(400, "no notes to send");
    const result = this.queue(key, session.drafts, session.draftStructure);
    this.#draftsChanged(session, [], session.chat.slice(-result.accepted));
    return result;
  }

  #draftsChanged(session, drafts, sent) {
    session.drafts = drafts;
    if (drafts.length === 0) delete session.draftStructure;
    session.lastActive = new Date().toISOString();
    this.#persist(session);
    // Every tab on the review shows the same unsent notes, whichever of them changed the list.
    // Notes that left for the agent travel in the same event, so a tab moves them in one step and
    // ahead of any reply to them; a refetch could be answered before a reply and read after it.
    this.#events.emit(session.key, { type: "drafts", drafts, ...(sent && { sent }) });
    return { drafts };
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

  /** The file changed on disk: number the new state, or say it is gone, and tell every open tab. */
  fileChanged(key) {
    // A watcher can outlive its session by a beat if the session was evicted; then there is nothing
    // to renumber, so tolerate the gap rather than throwing inside the fs.watch callback.
    const session = this.#sessions.get(key);
    if (!session) return 0;
    if (!existsSync(session.file)) {
      this.#gone(session);
      return session.revision;
    }
    session.revision += 1;
    this.#persist(session);
    this.#events.emit(key, { type: "reload", revision: session.revision });
    return session.revision;
  }

  /**
   * Ends the review. `drafts` says what happens to the unsent notes in the same step, so a
   * send-and-end can never strand them: "send" queues them, "discard" drops them, and leaving it
   * out keeps them sendable, which is what the agent's own end does. `by` is who closed the loop:
   * a user end refuses a plain reopen, an agent end does not.
   */
  end(key, by, drafts) {
    const session = this.get(key);
    // A review whose file moved or was deleted has nothing left to end; whoever asked, and every
    // open tab, is told that instead, so the answer is the one a poll on that path gets.
    if (!existsSync(session.file)) return this.#gone(session);
    const unsent = session.drafts ?? [];
    const queued =
      drafts === "send" && unsent.length > 0
        ? this.#accept(session, unsent, session.draftStructure)
        : 0;
    if (drafts === "send" || drafts === "discard")
      this.#draftsChanged(session, [], queued > 0 ? session.chat.slice(-queued) : undefined);
    // Who closed the loop is the first answer, not the last. An agent tidying up after the
    // reviewer already ended would otherwise relabel it as its own and, since only a user end
    // refuses a plain reopen, hand itself back a review the reviewer deliberately closed.
    if (!session.endedAt) {
      session.endedAt = new Date().toISOString();
      session.endedBy = by;
    }
    const endedBy = session.endedBy;
    this.#clearWorking(key);
    this.#persist(session);
    this.#events.emit(key, { type: "ended", by: endedBy, queued });
    return { status: "ended", ended_by: endedBy, queued };
  }

  /**
   * The agent's answer to one note, which the reviewer reads on that note: done, declined or a
   * question. A later reply replaces an earlier one, so a question answered can become done.
   */
  reply(key, uid, raw) {
    const session = this.get(key);
    // The reviewer can no longer read it on the note, so it gets the answer a poll and an end get.
    if (!existsSync(session.file)) return this.#gone(session);
    if (!Number.isInteger(uid) || uid < 1)
      throw new HttpError(400, "uid must be a positive integer");
    const note = session.chat.find((entry) => entry.uid === uid);
    if (!note) throw new HttpError(404, `no note ${uid} in this review`);
    note.reply = { ...validateReply(raw), at: new Date().toISOString() };
    session.lastActive = note.reply.at;
    this.#persist(session);
    this.#events.emit(key, { type: "reply", uid, reply: note.reply });
    // Working means notes taken and not yet answered; an answer to the last of them ends it, or a
    // tab reads "working" beside "answered every note" until the agent's next poll or the bound.
    const taken = session.unacked?.prompts ?? [];
    const answered = (prompt) => session.chat.find((entry) => entry.uid === prompt.uid)?.reply;
    if (taken.length > 0 && taken.every(answered)) this.#clearWorking(key);
    return { status: "replied", uid, reply: note.reply };
  }

  /** Reopens an ended review, so a tab still showing the ended notice comes back to life. */
  reopen(key) {
    const session = this.get(key);
    if (!session.endedAt) return;
    delete session.endedAt;
    delete session.endedBy;
    this.#persist(session);
    this.#events.emit(key, { type: "reopened" });
  }

  /** Drains the queue, clearing it as the batch leaves. Delivery goes through #answer, not this. */
  take(key) {
    const session = this.get(key);
    const prompts = session.pending;
    session.pending = [];
    if (prompts.length > 0) this.#persist(session);
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
  #answer(key, cursor, redeliver) {
    const session = this.get(key);
    // A poll whose cursor has reached the outstanding batch confirms it arrived; only then is it
    // cleared. A missing or stale cursor leaves the batch to be redelivered unchanged, and so does
    // one from an earlier life of this session, whose uids are no measure of this one's.
    if (
      session.unacked &&
      cursor?.epoch === session.epoch &&
      cursor.uid >= session.unacked.receipt
    ) {
      delete session.unacked;
      this.#persist(session);
    }
    const ended = session.endedAt ? { ended_by: session.endedBy } : null;
    // Notes already taken or queued are still delivered after the file goes; once there is
    // nothing left to deliver, a gone file is the answer, ahead of an end.
    const final = !existsSync(session.file)
      ? { status: "gone", file: session.file }
      : ended && { status: "ended", ...ended };
    // One batch is in flight at a time. A fresh poll (redeliver) re-sends the outstanding batch, so a
    // poll whose response was lost gets the identical notes - same uids, idempotent - not a drop. A
    // poll woken while another already holds that batch does not, so two pollers never split one
    // batch, and a newer batch waits behind the outstanding one, keeping the order the reviewer set.
    if (session.unacked) {
      if (!redeliver) return final;
      const { prompts, structure, receipt } = session.unacked;
      return {
        status: "feedback",
        prompts,
        structure,
        receipt,
        epoch: session.epoch,
        ...(ended && { session_ended: true, ...ended }),
      };
    }
    if (session.pending.length > 0) {
      const prompts = session.pending;
      session.pending = [];
      const receipt = prompts[prompts.length - 1].uid;
      session.unacked = { prompts, structure: session.structure ?? "", receipt };
      this.#persist(session);
      return {
        status: "feedback",
        prompts,
        structure: session.unacked.structure,
        receipt,
        epoch: session.epoch,
        ...(ended && { session_ended: true, ...ended }),
      };
    }
    return final;
  }

  /** Tells every open tab the file is gone, and returns the answer the CLI prints for it. */
  #gone(session) {
    this.#events.emit(session.key, { type: "gone" });
    // Nothing the page can do waits on the agent any more, so it no longer shows it working.
    this.#clearWorking(session.key);
    return { status: "gone", file: session.file };
  }

  /**
   * Resolves with the poll's answer, `waiting` at the timeout, or null when the caller went away.
   * `cursor` is `{ uid, epoch }`: the high uid the agent last received and the session life it came from.
   */
  waitForFeedback(key, timeoutMs, signal, cursor) {
    // A fresh poll may redeliver the outstanding batch; a poll woken by an event may not.
    const immediate = this.#answer(key, cursor, true);
    if (immediate) {
      // An answer inside a grace ends it, going straight from listening to what the answer means.
      if (this.#takeLingering(key)) this.#release(key, immediate.status === "feedback");
      else if (immediate.status === "feedback") this.#setWorking(key);
      if (immediate.status === "gone") this.#gone(this.get(key));
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
        if (event.type !== "feedback" && event.type !== "ended" && event.type !== "gone") return;
        const answer = this.#answer(key, cursor, false);
        if (answer) finish(answer);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish({ status: "waiting" }), timeoutMs);
      this.#events.on(key, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #attach(key) {
    // The poll that just ended with nothing is still counted, so this one takes its place unseen.
    if (this.#takeLingering(key)) return;
    const before = this.presence(key).state;
    this.#pollsByKey.set(key, (this.#pollsByKey.get(key) ?? 0) + 1);
    this.#clearWorking(key, false);
    this.#announce(key, before);
  }

  #takeLingering(key) {
    const lingering = this.#lingering.get(key);
    if (!lingering) return false;
    clearTimeout(lingering);
    this.#lingering.delete(key);
    return true;
  }

  #detach(key, delivered) {
    // A last poll that delivered nothing is held for a grace before it counts as gone: a long wait is
    // a run of requests (`poll` in src/cli.js), and the agent has not left between two of them.
    if (!delivered && this.#pollsByKey.get(key) === 1) {
      const timer = setTimeout(() => {
        this.#lingering.delete(key);
        this.#release(key, false);
      }, limits.pollGraceMs);
      timer.unref();
      this.#lingering.set(key, timer);
      return;
    }
    this.#release(key, delivered);
  }

  #release(key, delivered) {
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

/**
 * The folder a review's assets resolve within: the file's own unless the agent named a wider one,
 * canonicalised so a symlinked spelling cannot stretch it, and holding the file it serves.
 */
function assetRoot(root, file) {
  if (root === undefined) return dirname(file);
  let canonical;
  try {
    canonical = canonicalFile(root);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      throw new HttpError(404, `no such directory: ${root}`);
    throw error;
  }
  if (!statSync(canonical).isDirectory())
    throw new HttpError(400, `root is not a directory: ${root}`);
  if (isOutside(canonical, file))
    throw new HttpError(400, `${file} is not inside root ${canonical}`);
  return canonical;
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
  /** @type {{ prompt: string, selector: string, lines?: number[], tag: string, text: string, at?: string, target?: object, answers?: number }} */
  const prompt = {
    prompt: str(raw, "prompt", "prompt", limits.promptTextChars),
    selector: str(raw, "prompt", "selector", 2000),
    ...(raw.lines !== undefined && { lines: validateLines(raw.lines) }),
    tag: str(raw, "prompt", "tag", 64),
    text: str(raw, "prompt", "text", 2000),
  };
  if (prompt.prompt.trim() === "") throw new HttpError(400, "prompt.prompt is empty");
  if (raw.at !== undefined) prompt.at = str(raw, "prompt", "at", 40);
  if (raw.target !== undefined) prompt.target = validateTarget(raw.target);
  if (raw.answers !== undefined) {
    if (!Number.isInteger(raw.answers) || raw.answers < 1)
      throw new HttpError(400, "prompt.answers must be a note's uid");
    prompt.answers = raw.answers;
  }
  return prompt;
}

/** The first and last source line of the block a note is on, 1-based and inclusive. */
function validateLines(raw) {
  const [start, end] = Array.isArray(raw) && raw.length === 2 ? raw : [];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    throw new HttpError(400, "prompt.lines must be [first, last] line numbers");
  return [start, end];
}

export const REPLY_STATUSES = ["done", "declined", "question"];

/** The message is the agent's and is shown to the reviewer, so it is bounded; the chrome sets it as text. */
function validateReply(raw) {
  if (raw === null || typeof raw !== "object") throw new HttpError(400, "reply must be an object");
  if (!REPLY_STATUSES.includes(raw.status))
    throw new HttpError(400, `reply.status must be one of ${REPLY_STATUSES.join(", ")}`);
  const message = raw.message === undefined ? "" : str(raw, "reply", "message", limits.replyChars);
  if (raw.status === "question" && message.trim() === "")
    throw new HttpError(400, "a question needs its text in reply.message");
  return message.trim() === "" ? { status: raw.status } : { status: raw.status, message };
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
  if (raw.type === "control") return { type: "control", name: str(raw, "target", "name", 200) };
  if (raw.type === "media") {
    const media = { type: "media" };
    for (const [field, max] of [
      ["alt", 200],
      ["name", 200],
      ["src", 2000],
    ]) {
      if (raw[field] !== undefined) media[field] = str(raw, "target", field, max);
    }
    for (const field of ["x", "y", "width", "height"]) {
      if (raw[field] === undefined) continue;
      if (!Number.isInteger(raw[field]) || raw[field] < 0)
        throw new HttpError(400, `target.${field} must be a non-negative integer`);
      media[field] = raw[field];
    }
    return media;
  }
  throw new HttpError(400, "unknown target.type");
}

function validateStructure(raw) {
  if (typeof raw !== "string") throw new HttpError(400, "structure must be a string");
  if (raw.length > limits.structureChars)
    throw new HttpError(400, `structure over ${limits.structureChars} characters`);
  return raw;
}
