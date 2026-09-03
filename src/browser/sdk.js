// Runs inside the sandboxed artifact: finds the element the reviewer points at and hands the note up.
(() => {
  const chromeOrigin = new URL(location.href).origin;
  const SKIP = new Set([
    "HTML",
    "HEAD",
    "BODY",
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "TITLE",
    "NOSCRIPT",
  ]);
  const INTERACTIVE = "a[href], button, input, select, textarea, label, summary, [contenteditable]";
  const MAX_FOCUSABLE = 2000;
  let nonce = "";
  let annotate = false;
  let focusable = [];
  let open = null;

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { font: 14px/1.4 system-ui, sans-serif; }
      .box { position: fixed; pointer-events: none; border: 2px solid oklch(78% 0.12 230); border-radius: 3px; box-shadow: 0 0 0 2px oklch(78% 0.12 230 / 0.25); display: none; }
      .card { position: fixed; width: min(360px, calc(100vw - 24px)); padding: 12px; border-radius: 6px; background: oklch(22% 0.02 260); color: oklch(93% 0.01 90); box-shadow: 0 8px 24px oklch(0% 0 0 / 0.35); display: none; }
      .card.open { display: block; }
      .target { margin: 0 0 8px; font: 12px ui-monospace, monospace; color: oklch(78% 0.12 230); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      textarea { width: 100%; min-height: 64px; box-sizing: border-box; padding: 8px; border: 1px solid oklch(40% 0.015 260); border-radius: 6px; background: oklch(30% 0.015 260); color: inherit; font: inherit; resize: vertical; }
      textarea:focus-visible, button:focus-visible { outline: 2px solid oklch(78% 0.12 230); outline-offset: 2px; }
      .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
      button { min-height: 32px; padding: 0 12px; border: 0; border-radius: 6px; font: 600 13px system-ui, sans-serif; cursor: pointer; }
      .add { background: oklch(78% 0.12 230); color: oklch(20% 0.05 230); }
      .cancel { background: transparent; color: oklch(72% 0.02 260); border: 1px solid oklch(40% 0.015 260); }
    </style>
    <div class="box"></div>
    <form class="card" role="dialog" aria-label="Leave a note">
      <p class="target"></p>
      <textarea placeholder="What should change here?" aria-label="Note"></textarea>
      <div class="row"><button type="button" class="cancel">Cancel</button><button type="submit" class="add">Add note</button></div>
    </form>`;
  const box = /** @type {HTMLElement} */ (shadow.querySelector(".box"));
  const card = /** @type {HTMLFormElement} */ (shadow.querySelector(".card"));
  const targetLine = shadow.querySelector(".target");
  const textarea = /** @type {HTMLTextAreaElement} */ (shadow.querySelector("textarea"));

  const send = (message) => parent.postMessage({ ...message, nonce }, chromeOrigin);

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== chromeOrigin) return;
    const data = event.data;
    if (data?.type === "init") {
      nonce = data.nonce;
      // A reload replaces the document, so the chrome hands back where the reviewer was reading.
      if (data.scroll) restoreScroll(data.scroll);
      setAnnotate(data.annotate);
      // The chrome counts the page shown only once it has finished loading, been put back where
      // the reviewer was, and become annotatable; anything earlier is a page still moving.
      whenLoaded(() => send({ type: "shown" }));
    } else if (data?.nonce === nonce && data.type === "annotate") {
      setAnnotate(data.on);
      // The chrome cannot otherwise know when this arrived: it posts into a
      // separate event loop, so anything that acts on the new state - a click,
      // a test - would be racing delivery.
      send({ type: "annotate-ok", on: data.on });
    }
  });

  function whenLoaded(then) {
    if (document.readyState === "complete") then();
    else window.addEventListener("load", then, { once: true });
  }

  // Layout can still grow after this script runs, which clamps an early scroll short of where
  // the reviewer was; the second pass at load lands it.
  function restoreScroll(to) {
    const apply = () => window.scrollTo(to.x, to.y);
    apply();
    whenLoaded(apply);
  }

  function candidate(node) {
    let element = node instanceof Element ? node : node?.parentElement;
    if (!element || host.contains(element)) return null;
    if (element.closest(INTERACTIVE)) return null;
    while (element && SKIP.has(element.tagName)) element = element.parentElement;
    return element;
  }

  // Elements that carry content of their own become Tab stops, so a keyboard reaches every note-worthy spot.
  function setAnnotate(on) {
    annotate = on;
    for (const element of focusable) element.removeAttribute("tabindex");
    focusable = [];
    if (!on) {
      closeCard();
      box.style.display = "none";
      return;
    }
    for (const element of document.body.querySelectorAll("*")) {
      if (focusable.length >= MAX_FOCUSABLE) break;
      if (SKIP.has(element.tagName) || host.contains(element) || element.closest(INTERACTIVE))
        continue;
      if (element.hasAttribute("tabindex")) continue;
      const ownText = [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (ownText || /^(IMG|SVG|TABLE|TR|PRE|FIGURE|VIDEO|CANVAS)$/.test(element.tagName)) {
        element.setAttribute("tabindex", "0");
        focusable.push(element);
      }
    }
  }

  function outline(element) {
    if (!element) {
      box.style.display = "none";
      return;
    }
    const r = element.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function selectorFor(element) {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts = [];
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const siblings = [...node.parentElement.children].filter((s) => s.tagName === node.tagName);
      parts.unshift(
        siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
      );
    }
    return parts.join(" > ");
  }

  function openCard(element) {
    open = element;
    send({ type: "editing", on: true });
    outline(element);
    targetLine.textContent = `${element.tagName.toLowerCase()} · ${visibleText(element)}`;
    textarea.value = "";
    const r = element.getBoundingClientRect();
    card.classList.add("open");
    const top = Math.min(Math.max(8, r.bottom + 8), window.innerHeight - card.offsetHeight - 8);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - card.offsetWidth - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    textarea.focus();
  }

  function closeCard() {
    if (!open) return;
    const element = open;
    open = null;
    send({ type: "editing", on: false });
    card.classList.remove("open");
    box.style.display = "none";
    if (annotate && element.isConnected) element.focus({ preventScroll: true });
  }

  function visibleText(element) {
    // innerText keeps the spaces layout puts between cells and lines; textContent runs them together.
    return (element.innerText ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  card.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = textarea.value.trim();
    if (!open || prompt === "") return;
    send({
      type: "queue",
      prompt: {
        prompt,
        selector: selectorFor(open),
        tag: open.tagName.toLowerCase(),
        text: visibleText(open),
      },
    });
    closeCard();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      card.requestSubmit();
    }
  });
  shadow.querySelector(".cancel").addEventListener("click", closeCard);
  shadow.addEventListener("keydown", (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === "Escape") closeCard();
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!annotate || open || event.composedPath().includes(host)) return;
      const element = candidate(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      openCard(element);
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (!annotate || open || event.composedPath().includes(host)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = candidate(document.activeElement);
    if (!element || element === document.body) return;
    event.preventDefault();
    openCard(element);
  });
  document.addEventListener("mouseover", (event) => {
    if (annotate && !open) outline(candidate(event.target));
  });
  document.addEventListener("focusin", (event) => {
    if (annotate && !open) outline(candidate(event.target));
  });

  // One report per frame at most: the chrome only needs the last position before a reload.
  let scrolling = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrolling) return;
      scrolling = true;
      requestAnimationFrame(() => {
        scrolling = false;
        send({ type: "scroll", x: window.scrollX, y: window.scrollY });
      });
    },
    { passive: true },
  );

  document.documentElement.append(host);
  send({ type: "ready" });
})();
