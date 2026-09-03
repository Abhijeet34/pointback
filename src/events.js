import { watchFile } from "./watch.js";

/**
 * The live channel to open review tabs: one NDJSON stream per tab and one file watcher per
 * session with a tab on it. NDJSON over `fetch` rather than an event source, because the
 * capability token travels in a header and an event source cannot send one.
 *
 * The newest tab on a session is the current one and owns the artifact view; older tabs are
 * told the moment they lose it and are promoted back when the current tab goes away, so a
 * superseded tab never learns about it from a reload that silently did nothing.
 */
export class EventStreams {
  #store;
  #groups = new Map();
  #count = 0;

  constructor(store) {
    this.#store = store;
  }

  get size() {
    return this.#count;
  }

  /** Attaches a writer to a session's channel; returns the function that detaches it. */
  open(key, write) {
    const session = this.#store.get(key);
    const group = this.#groups.get(key) ?? this.#watch(key, session.file);
    const previous = group.streams.at(-1);
    group.streams.push(write);
    this.#count += 1;
    if (previous) previous({ type: "superseded" });
    write({ type: "hello", ...this.#store.status(key) });
    return () => this.#close(key, write);
  }

  /** Stops every watcher; the server calls this on its way down so no watch outlives it. */
  closeAll() {
    for (const group of this.#groups.values()) group.stop();
    this.#groups.clear();
    this.#count = 0;
  }

  #watch(key, file) {
    const onEvent = (event) => {
      // A queued batch is the agent's business; a tab hears about it through presence instead.
      if (event.type === "feedback") return;
      for (const write of this.#groups.get(key)?.streams ?? []) write(event);
    };
    this.#store.on(key, onEvent);
    const unwatch = watchFile(file, () => this.#store.bumpRevision(key), {
      // A watch that dies takes live reload with it; saying so beats a page that quietly stops updating.
      onError: () => onEvent({ type: "reload-off" }),
    });
    const group = {
      streams: [],
      stop: () => {
        unwatch();
        this.#store.off(key, onEvent);
      },
    };
    this.#groups.set(key, group);
    return group;
  }

  #close(key, write) {
    const group = this.#groups.get(key);
    if (!group) return;
    const index = group.streams.indexOf(write);
    if (index === -1) return;
    const wasCurrent = index === group.streams.length - 1;
    group.streams.splice(index, 1);
    this.#count -= 1;
    if (group.streams.length === 0) {
      group.stop();
      this.#groups.delete(key);
      return;
    }
    // The tab that was hidden behind this one takes the review back, catching up on what it missed.
    if (wasCurrent) group.streams.at(-1)({ type: "current", ...this.#store.status(key) });
  }
}
