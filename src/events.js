import { watchFile } from "./watch.js";

/**
 * The live channel to open review tabs: one event stream per tab, a WebSocket carrying one JSON
 * message per event (`eventStream` in server.js says why), and one file watcher per session with
 * a tab on it.
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

  /** Whether a tab is showing this review right now, so opening the file again need not open another. */
  live(key) {
    return (this.#groups.get(key)?.streams.length ?? 0) > 0;
  }

  /** Attaches a writer to a session's channel; returns the function that detaches it. */
  open(key, write) {
    const session = this.#store.get(key);
    const group = this.#groups.get(key) ?? this.#group(key);
    // A watcher that died is started again for the next tab, so the refresh its notice advises works.
    if (!group.unwatch) this.#watch(key, session.file, group);
    const previous = group.streams.at(-1);
    group.streams.push(write);
    this.#count += 1;
    if (previous) previous({ type: "superseded" });
    write({ type: "hello", ...this.#state(key, group) });
    return () => this.#close(key, write);
  }

  /** Stops every watcher; the server calls this on its way down so no watch outlives it. */
  closeAll() {
    for (const group of this.#groups.values()) group.stop();
    this.#groups.clear();
    this.#count = 0;
  }

  #group(key) {
    const onEvent = (event) => {
      // A queued batch is the agent's business; a tab hears about it through presence instead.
      if (event.type === "feedback") return;
      // A poll or an end that finds the file gone tells the tabs before the watcher may have seen
      // it go, and only the watcher can tell them it came back.
      if (event.type === "gone") group.unwatch?.missing();
      for (const write of group.streams) write(event);
    };
    this.#store.on(key, onEvent);
    const group = {
      streams: [],
      /** The live watcher's stop, or undefined while nothing watches the file. */
      unwatch: undefined,
      onEvent,
      stop: () => {
        group.unwatch?.();
        this.#store.off(key, onEvent);
      },
    };
    this.#groups.set(key, group);
    return group;
  }

  #watch(key, file, group) {
    try {
      group.unwatch = watchFile(file, () => this.#store.fileChanged(key), {
        // A watch that dies takes live reload with it; saying so beats a page that quietly stops updating.
        onError: () => {
          group.unwatch = undefined;
          group.onEvent({ type: "reload-off" });
        },
      });
    } catch {
      // The file's directory is gone too, so there is nothing to watch; the tab's hello says `gone`.
    }
    // Only now, with the watch on, so a save is either numbered here or seen by the watch; that
    // covers one made while a watch that died was down, too.
    this.#store.catchUp(key);
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
    if (wasCurrent) group.streams.at(-1)({ type: "current", ...this.#state(key, group) });
  }

  /**
   * What a tab must match, with the files its page goes without and whether the file is followed
   * for it: a tab whose stream was down when an open rerooted the review hears of it only here.
   */
  #state(key, group) {
    return {
      ...this.#store.status(key),
      outside: this.#store.outside(key),
      liveReload: group.unwatch !== undefined,
    };
  }
}
