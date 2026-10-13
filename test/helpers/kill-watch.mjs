// Loaded into a daemon by NODE_OPTIONS=--import: the first event its file watchers hear about an
// entry named in KILL_WATCH_ON fails that watcher, exactly as a watcher failing at runtime does
// (`onError` in src/watch.js). A file rather than a signal, since Windows has no SIGUSR2; once per
// process, since macOS replays recent history into a watcher started later.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const trigger = process.env.KILL_WATCH_ON;
const original = fs.watch;
let killed = false;
fs.watch = (path, options, listener) => {
  const watcher = original(path, options, (event, changed) => {
    if (trigger && !killed && changed === trigger) {
      killed = true;
      watcher.emit(
        "error",
        Object.assign(new Error("injected watcher failure"), { code: "EINJECTED" }),
      );
    } else listener(event, changed);
  });
  return watcher;
};
syncBuiltinESMExports();
