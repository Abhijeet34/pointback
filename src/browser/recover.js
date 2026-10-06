// The chrome's first script, before any file it watches is asked for. Windows refuses about 5 in
// 100000 of Chrome's new loopback connects (docs/ENGINEERING-NOTES.md), and nothing asks again for
// a refused script, sheet or face of the chrome's own: a refused chrome.js leaves a page that never
// boots, a sheet or a face one that paints wrong. So one failing reloads the chrome, and the reload
// leaves a flag in the tab's sessionStorage that the load it starts spends, so that load never asks
// again and a file that never loads costs one reload and no more. A reviewer's own reload finds no
// flag and gets its one. A reload that would take a half-typed note with it waits for the hold
// chrome.js registers to release.
{
  const key = "recoverReloaded";
  // The wrapper and the sandboxed page are cross-origin to this storage; unreadable storage counts as started.
  let started = true;
  try {
    started = sessionStorage.getItem(key) !== null;
    sessionStorage.removeItem(key);
  } catch {
    // Storage that cannot be read stays "started", so a file that fails here is never reloaded.
  }
  let held = () => false;
  let reloading = false;
  let waiting = false;
  const reload = () => {
    try {
      sessionStorage.setItem(key, "1");
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
      if (waiting && !reloading && !held()) reload();
    },
  };
  const refused = () => {
    if (started || reloading || waiting) return;
    if (held()) waiting = true;
    else reload();
  };
  addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLLinkElement || event.target instanceof HTMLScriptElement)
        refused();
    },
    true,
  );
  document.fonts.addEventListener("loadingerror", refused);
}
