// Runs inside the sandboxed artifact: finds the element, passage or cell the reviewer points at and hands the note up.
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
  const STRUCTURE =
    "h1, h2, h3, h4, h5, h6, main, nav, aside, header, footer, section, article, form, dialog, table, figure, ul, ol, dl, pre, blockquote, img, svg, video, canvas, details";
  const MAX_FOCUSABLE = 2000;
  // The outline rides inside an agent's context window, so it is bounded in characters, not elements.
  const MAX_OUTLINE_CHARS = 2000;
  const QUOTE_CHARS = 32;
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
      .box { position: fixed; pointer-events: none; border: 2px solid oklch(78% 0.12 230); border-radius: 3px; box-shadow: 0 0 0 2px oklch(78% 0.12 230 / 0.25); }
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
    <div class="boxes"></div>
    <form class="card" role="dialog" aria-label="Leave a note">
      <p class="target"></p>
      <textarea placeholder="What should change here?" aria-label="Note"></textarea>
      <div class="row"><button type="button" class="cancel">Cancel</button><button type="submit" class="add">Add note</button></div>
    </form>`;
  const boxes = /** @type {HTMLElement} */ (shadow.querySelector(".boxes"));
  const card = /** @type {HTMLFormElement} */ (shadow.querySelector(".card"));
  const targetLine = shadow.querySelector(".target");
  const textarea = /** @type {HTMLTextAreaElement} */ (shadow.querySelector("textarea"));

  const send = (message) => parent.postMessage({ ...message, nonce }, chromeOrigin);
  // SVG elements report a lowercase tagName, so every comparison against the lists above goes through this.
  const tagName = (element) => element.tagName.toUpperCase();
  const squash = (text) => text.replace(/\s+/g, " ");
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

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
    while (element && SKIP.has(tagName(element))) element = element.parentElement;
    return element;
  }

  // Elements that carry content of their own become Tab stops, so a keyboard reaches every note-worthy spot.
  function setAnnotate(on) {
    annotate = on;
    for (const element of focusable) element.removeAttribute("tabindex");
    focusable = [];
    if (!on) {
      closeCard();
      outlineRects([]);
      return;
    }
    for (const element of document.body.querySelectorAll("*")) {
      if (focusable.length >= MAX_FOCUSABLE) break;
      if (SKIP.has(tagName(element)) || host.contains(element) || element.closest(INTERACTIVE))
        continue;
      if (element.hasAttribute("tabindex")) continue;
      const ownText = [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (ownText || /^(IMG|SVG|TABLE|TR|PRE|FIGURE|VIDEO|CANVAS)$/.test(tagName(element))) {
        element.setAttribute("tabindex", "0");
        focusable.push(element);
      }
    }
  }

  function outlineRects(rects) {
    boxes.replaceChildren(
      ...[...rects].map((r) => {
        const box = document.createElement("div");
        box.className = "box";
        Object.assign(box.style, {
          left: `${r.left - 2}px`,
          top: `${r.top - 2}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        return box;
      }),
    );
  }

  function outline(element) {
    outlineRects(element ? [element.getBoundingClientRect()] : []);
  }

  /** Selector segments from `root` (exclusive) down to `element`, cut short at the nearest unique id. */
  function segments(element, root) {
    const parts = [];
    for (let node = element; node && node !== root; node = node.parentElement) {
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
    return parts;
  }

  const selectorFor = (element) => segments(element, document.body).join(" > ") || "body";

  function visibleText(element) {
    // innerText keeps the spaces layout puts between cells and lines; textContent runs them together.
    return squash(element.innerText ?? element.textContent ?? "")
      .trim()
      .slice(0, 200);
  }

  // Row and column names come from the header row and the row's first cell. Any spanned cell
  // shifts the grid, and a wrong name is worse than none, so a table with spans gets no names.
  function cellTarget(element) {
    if (!/^T[DH]$/.test(tagName(element))) return null;
    const row = /** @type {HTMLTableRowElement} */ (element.parentElement);
    const table = element.closest("table");
    if (row?.tagName !== "TR" || !table) return null;
    const target = { type: "table-cell" };
    const cells = [...table.querySelectorAll("td, th")].filter((c) => c.closest("table") === table);
    if (cells.some((c) => c.rowSpan !== 1 || c.colSpan !== 1)) return target;
    const header = [...table.rows].find(
      (r) => r.cells.length && [...r.cells].every((c) => c.tagName === "TH"),
    );
    const columnCell = header && header !== row ? header.cells[element.cellIndex] : null;
    if (columnCell) target.column = visibleText(columnCell);
    const rowCell =
      [...row.cells].find((c) => c.tagName === "TH" && c.getAttribute("scope") === "row") ??
      (header === row ? null : row.cells[0]);
    if (rowCell && rowCell !== element) target.row = visibleText(rowCell);
    return target;
  }

  function elementHit(element) {
    return {
      element,
      tag: element.tagName.toLowerCase(),
      text: visibleText(element),
      target: cellTarget(element),
      rects: [element.getBoundingClientRect()],
    };
  }

  function offsetWithin(element, node, offset) {
    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  // A passage is anchored by character offsets into its element's text content plus the text on
  // either side, which a page re-rendered from the same source still resolves; node paths would not.
  function passageHit(range) {
    if (range.collapsed) return null;
    const container = range.commonAncestorContainer;
    let element = container instanceof Element ? container : container.parentElement;
    if (!element || host.contains(element) || element.closest(INTERACTIVE)) return null;
    if (SKIP.has(tagName(element))) element = document.body;
    const whole = element.textContent;
    let start = offsetWithin(element, range.startContainer, range.startOffset);
    let end = offsetWithin(element, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(whole[start])) start += 1;
    while (end > start && /\s/.test(whole[end - 1])) end -= 1;
    if (start === end) return null;
    return {
      element,
      tag: "text",
      text: squash(whole.slice(start, end)).slice(0, 2000),
      target: {
        type: "text-range",
        start,
        end,
        before: squash(whole.slice(Math.max(0, start - QUOTE_CHARS), start)),
        after: squash(whole.slice(end, end + QUOTE_CHARS)),
      },
      rects: range.getClientRects(),
    };
  }

  function currentPassage(element) {
    const selection = getSelection();
    if (selection.isCollapsed || !element.contains(selection.anchorNode)) return null;
    return passageHit(selection.getRangeAt(0));
  }

  // Shift+Arrow grows a real selection a word at a time from the focused element's start, so a
  // keyboard reaches a passage the same way a drag does and the same anchor code sees it.
  function extendPassage(element, direction) {
    const selection = getSelection();
    if (selection.isCollapsed || !element.contains(selection.anchorNode)) {
      selection.setPosition(element, 0);
    }
    selection.modify("extend", direction, "word");
    if (!element.contains(selection.focusNode)) {
      selection.extend(element, direction === "forward" ? element.childNodes.length : 0);
    }
    const hit = currentPassage(element);
    outlineRects(hit ? hit.rects : [element.getBoundingClientRect()]);
  }

  function label(hit) {
    const cell = hit.target?.type === "table-cell" ? hit.target : {};
    const where = [cell.row, cell.column].filter(Boolean).join(" › ");
    const text = hit.tag === "text" ? `“${hit.text}”` : hit.text;
    return `${hit.tag} · ${text}${where ? ` · ${where}` : ""}`;
  }

  function openCard(hit) {
    open = hit;
    send({ type: "editing", on: true });
    outlineRects(hit.rects);
    targetLine.textContent = label(hit);
    textarea.value = "";
    const r = hit.rects[hit.rects.length - 1];
    card.classList.add("open");
    const top = Math.min(Math.max(8, r.bottom + 8), window.innerHeight - card.offsetHeight - 8);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - card.offsetWidth - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    textarea.focus();
  }

  function closeCard() {
    if (!open) return;
    const { element } = open;
    open = null;
    send({ type: "editing", on: false });
    card.classList.remove("open");
    outlineRects([]);
    if (annotate && element.isConnected) element.focus({ preventScroll: true });
  }

  function describe(element) {
    const tag = tagName(element);
    const text =
      tag === "TABLE"
        ? [...(element.rows[0]?.cells ?? [])].map(visibleText).join(" | ")
        : tag === "UL" || tag === "OL"
          ? `${element.children.length} items`
          : tag === "IMG"
            ? element.alt
            : tag === "FIGURE" || tag === "DETAILS"
              ? visibleText(element.querySelector("figcaption, summary") ?? element)
              : /^(H[1-6]|PRE|BLOCKQUOTE)$/.test(tag)
                ? visibleText(element)
                : "";
    return text ? ` "${clip(text, 60).replace(/"/g, "'")}"` : "";
  }

  // The page's structure as the reviewer sees it: headings, sections, tables, lists and figures,
  // each addressed relative to the listed element above it, and nothing that is not rendered.
  function pageOutline() {
    const lines = [];
    const depthOf = new Map();
    let chars = 0;
    let cut = 0;
    for (const element of document.body.querySelectorAll(STRUCTURE)) {
      if (!element.checkVisibility()) continue;
      const parent = element.parentElement?.closest(STRUCTURE) ?? document.body;
      const depth = (depthOf.get(parent) ?? -1) + 1;
      depthOf.set(element, depth);
      const line = `${"  ".repeat(depth)}${segments(element, parent).join(" > ")}${describe(element)}`;
      chars += line.length + 1;
      if (chars > MAX_OUTLINE_CHARS) cut += 1;
      else lines.push(line);
    }
    if (cut > 0) lines.push(`… ${cut} more`);
    return lines.join("\n");
  }

  card.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = textarea.value.trim();
    if (!open || prompt === "") return;
    send({
      type: "queue",
      prompt: {
        prompt,
        selector: selectorFor(open.element),
        tag: open.tag,
        text: open.text,
        ...(open.target && { target: open.target }),
      },
      structure: pageOutline(),
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
      if (!annotate || event.composedPath().includes(host)) return;
      const element = candidate(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      // The click that ends a text drag arrives after the card has opened for the passage.
      if (!open) openCard(elementHit(element));
    },
    true,
  );
  document.addEventListener(
    "mouseup",
    () => {
      if (!annotate || open) return;
      const selection = getSelection();
      const hit = selection.isCollapsed ? null : passageHit(selection.getRangeAt(0));
      if (hit) openCard(hit);
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (!annotate || open || event.composedPath().includes(host)) return;
    const element = candidate(document.activeElement);
    if (!element || element === document.body) return;
    if (event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      extendPassage(element, event.key === "ArrowRight" ? "forward" : "backward");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCard(currentPassage(element) ?? elementHit(element));
    } else if (event.key === "Escape") {
      getSelection().collapseToStart();
      outline(element);
    }
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
