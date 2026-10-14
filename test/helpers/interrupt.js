// A test run killed midway runs none of its tests' own cleanup, and what they started outlives it: a
// daemon is detached by design, and a CLI or a browser a test spawned is not ended with its parent. An
// orphaned CLI went on to start daemons, and an orphaned browser held a review's tab open, which keeps
// its daemon from idling out (docs/ENGINEERING-NOTES.md). So what a test file starts is registered here,
// and an interrupted file ends it all before it exits.
//
// It runs synchronously, so no test code runs between the first step and the exit: the children go
// first, so no CLI is left to start a daemon, then each state directory's own stop.
const children = new Set();
const cleanups = new Set();
let ending = false;

/** Kills `child` if this file is interrupted while it runs. */
export function ownChild(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

/** Runs `cleanup`, which must be synchronous, if this file is interrupted; returns its undo. */
export function ownCleanup(cleanup) {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

function interrupt(code) {
  if (ending) return;
  ending = true;
  for (const child of children) child.kill("SIGKILL");
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // One cleanup that fails must not leave the rest undone.
    }
  }
  process.exit(code);
}

// `node --test` passes SIGINT and SIGTERM on to each file as SIGTERM; a terminal's Ctrl-C sends SIGINT
// to the whole group and a closed terminal SIGHUP. A runner killed outright closes the pipe the file
// reports on, which is the one sign of it the file gets on POSIX. Windows runs none of this: a SIGTERM
// ends a process at once, and libuv ends every child it did not detach with its parent, so there the
// file, its CLIs and its browser go with the runner, and only the detached daemons stay, to idle out.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.on(signal, () => interrupt(code));
}
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
    interrupt(1);
  });
}
