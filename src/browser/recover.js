// The chrome's first script, before any file it watches is asked for. Windows refuses about 5 in
// 100000 of Chrome's new loopback connects (docs/ENGINEERING-NOTES.md), and nothing asks again for
// a refused script, sheet or face of the chrome's own: a refused chrome.js leaves a page that never
// boots, a sheet or a face one that paints wrong. So one failing reloads the chrome, and the reload
// leaves the files the reloads so far were for in the tab's sessionStorage, which the load it starts
// spends: that load reloads again only for a file not on that list, so a file that never loads costs
// one reload, and a chain of reloads ends within the chrome's own files. A reviewer's own reload
// finds no list and starts a new one. A reload that would take a half-typed note with it waits for
// the hold chrome.js registers to release. So does one while the browser is offline, whose reload
// the browser refuses too and answers with its own error page in place of the review: it waits for
// the browser to come back online.
{
  const key = "recoverReloaded";
  // The wrapper and the sandboxed page are cross-origin to this storage; storage that cannot be read
  // leaves no list, and a file that fails then is never reloaded.
  let reloadedFor = null;
  try {
    const stored = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    const files = JSON.parse(stored ?? "[]");
    if (Array.isArray(files)) reloadedFor = files;
  } catch {
    // Unreadable storage, or a value this script did not write, reloads for nothing.
  }
  let held = () => false;
  let reloading = false;
  /** The file a reload held by a note is waiting to be made for. */
  let waiting = null;
  const reload = (file) => {
    try {
      sessionStorage.setItem(key, JSON.stringify([...reloadedFor, file]));
    } catch {
      return;
    }
    reloading = true;
    location.reload();
  };
  globalThis.recover = {
    hold: (check) => {
      held = check;
    },
    release: () => {
      if (waiting !== null && !reloading && navigator.onLine && !held()) reload(waiting);
    },
  };
  addEventListener("online", globalThis.recover.release);
  const refused = (file) => {
    if (!reloadedFor || reloadedFor.includes(file) || reloading || waiting !== null) return;
    if (!navigator.onLine || held()) waiting = file;
    else reload(file);
  };
  addEventListener(
    "error",
    (event) => {
      const { target } = event;
      if (target instanceof HTMLLinkElement) refused(target.href);
      else if (target instanceof HTMLScriptElement) refused(target.src);
    },
    true,
  );
  document.fonts.addEventListener("loadingerror", (event) => {
    for (const face of event.fontfaces) refused(`${face.family} ${face.weight}`);
  });
}
