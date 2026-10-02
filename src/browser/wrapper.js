// The frame between the chrome and the page under review, and the one witness the chrome trusts
// about the reviewer's gestures. It runs in an opaque origin of its own, so a click or key in the
// chrome never activates it while one in the page always does (HTML's activation notification
// reaches a document's ancestors and its same-origin descendants only). Everything the page posts
// reaches the chrome through here, stamped with this frame's own `navigator.userActivation`, which
// the page can neither read nor forge. docs/THREAT-MODEL.md names what that check still allows.
const chromeOrigin = new URL(location.href).origin;
const page = /** @type {HTMLIFrameElement} */ (document.getElementById("page"));
const toChrome = (message) => parent.postMessage(message, chromeOrigin);

window.addEventListener("message", (event) => {
  if (event.source === parent && event.origin === chromeOrigin) {
    if (event.data?.type === "show") page.src = event.data.url;
    else page.contentWindow?.postMessage(event.data, "*");
  } else if (event.source === page.contentWindow) {
    toChrome({
      type: "page",
      active: navigator.userActivation?.isActive === true,
      message: event.data,
    });
  }
});

// The chrome cannot see the page's loads through this frame, and a load the page did not announce
// itself in is how it learns the page strayed.
page.addEventListener("load", () => toChrome({ type: "loaded" }));

// Focus the chrome hands this frame belongs to the page inside it, as it did when the chrome framed
// the page directly; focus already in the page is left where it is.
window.addEventListener("focus", () => {
  if (document.activeElement !== page) page.focus();
});

toChrome({ type: "wrapper" });
