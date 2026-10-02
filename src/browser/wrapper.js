// The frame between the chrome and the page under review, and the one witness the chrome trusts
// about the reviewer's gestures. The chrome loads it as a data: document, an opaque origin of its
// own, so a click or key in the chrome never activates it while one in the page always does (HTML's
// activation notification reaches a document's ancestors and its same-origin descendants only).
// Everything the page posts reaches the chrome through here, stamped with this frame's own
// `navigator.userActivation`, which the page can neither read nor forge. docs/THREAT-MODEL.md
// names what that check still allows.
let page = /** @type {HTMLIFrameElement | null} */ (null);
// The parent is always the chrome that made this frame; a data: document has no origin to name it by.
const toChrome = (message) => parent.postMessage(message, "*");

window.addEventListener("message", (event) => {
  if (event.source === parent) {
    if (event.data?.type === "show") show(event.data.url);
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

// Focus the chrome hands this frame belongs to the page inside it, as it did when the chrome framed
// the page directly; focus already in the page is left where it is.
window.addEventListener("focus", () => {
  if (page && document.activeElement !== page) page.focus();
});

toChrome({ type: "wrapper" });
