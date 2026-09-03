import { statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

// A save is rarely one write: editors write a temp file and rename it over the original, or
// write in chunks. The trailing debounce folds that burst into one change.
export const DEBOUNCE_MS = 100;

/**
 * Calls `onChange` once per burst of writes to `file`; returns a function that stops watching.
 * The parent directory is watched rather than the file, because a rename-replace save leaves an
 * inode watch pointing at the old file while a directory watch sees the new one arrive.
 */
export function watchFile(file, onChange, { debounceMs = DEBOUNCE_MS, onError = () => {} } = {}) {
  const name = basename(file);
  let last = signature(file);
  let timer;
  // macOS replays recent history into a new watcher, so an event alone proves nothing; only a
  // changed size or mtime does. Ceiling: two same-size saves inside one mtime tick look like one.
  const fire = () => {
    const now = signature(file);
    if (now === null || now === last) return;
    last = now;
    onChange();
  };
  const watcher = watch(dirname(file), { persistent: false }, (_event, changed) => {
    // A platform that reports no filename reports every entry; then every event may be ours.
    if (changed && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  });
  watcher.on("error", (error) => {
    watcher.close();
    onError(error);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function signature(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}
