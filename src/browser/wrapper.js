// The frame between the chrome and the page under review, and the one witness the chrome trusts
// about the reviewer's gestures. It is served under the loopback name the chrome is not, so it is
// another origin, and a click or key in the chrome never activates it while one in the page always
// does (HTML's activation notification reaches a document's ancestors and its same-origin descendants
// only).
// Everything the page posts reaches the chrome through here, stamped with this frame's own
// `navigator.userActivation`, which the page can neither read nor forge. docs/THREAT-MODEL.md
// names what that check still allows.
const chromeOrigin = `http://${location.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${location.port}`;
let page = /** @type {HTMLIFrameElement | null} */ (null);
const toChrome = (message) => parent.postMessage(message, chromeOrigin);

window.addEventListener("message", (event) => {
  if (event.source === parent && event.origin === chromeOrigin) {
    if (event.data?.type === "show") show(event.data.url);
    else if (event.data?.type === "unload") unload();
    else page?.contentWindow?.postMessage(event.data, "*");
  } else if (page && event.source === page.contentWindow) {
    toChrome({
      type: "page",
      active: navigator.userActivation?.isActive === true,
      message: event.data,
    });
  }
});

/** Shows the page at `url`, making the frame the first time. */
function show(url) {
  if (page) {
    page.src = url;
    return;
  }
  page = document.createElement("iframe");
  page.id = "page";
  page.title = "The page under review";
  page.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  page.referrerPolicy = "no-referrer";
  page.src = url;
  // The chrome cannot see the page's loads through this frame, and a load the page did not
  // announce itself in is how it learns the page strayed.
  page.addEventListener("load", () => toChrome({ type: "loaded" }));
  document.body.append(page);
}

/**
 * Takes the page out of this document at once, where it can hold no focus and hear no key, and shows
 * about:blank in its place until the chrome shows the page again; navigating the frame instead leaves
 * the page able to take the focus until about:blank commits.
 */
function unload() {
  page?.remove();
  page = null;
  show("about:blank");
  toChrome({ type: "unloaded" });
}

// Focus the chrome hands this frame belongs to the page inside it, as it did when the chrome framed
// the page directly; focus already in the page is left where it is.
window.addEventListener("focus", () => {
  if (page && document.activeElement !== page) page.focus();
});

toChrome({ type: "wrapper" });
