// The chrome's first script, before any file it watches is asked for. Windows refuses about 5 in
// 100000 of Chrome's new loopback connects (docs/ENGINEERING-NOTES.md), and nothing asks again for
// a refused script, sheet or face of the chrome's own: a refused chrome.js leaves a page that never
// boots, a sheet or a face one that paints wrong. So one failing reloads the chrome, never from a
// load that was itself a reload, so a file that never loads costs one reload and no more.
{
  const [navigation] = /** @type {PerformanceNavigationTiming[]} */ (
    performance.getEntriesByType("navigation")
  );
  const reloaded = navigation?.type === "reload";
  let reloading = false;
  const refused = () => {
    if (reloaded || reloading) return;
    reloading = true;
    location.reload();
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
