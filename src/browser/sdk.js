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

  // Only the selection highlight lives in the artifact; the note card lives in the chrome, so the
  // artifact never composes the reviewer's instruction. See selectTarget below and chrome.js.
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { font: 14px/1.4 system-ui, sans-serif; }
      .box { position: fixed; pointer-events: none; border: 2px solid oklch(78% 0.12 230); border-radius: 3px; box-shadow: 0 0 0 2px oklch(78% 0.12 230 / 0.25); }
    </style>
    <div class="boxes"></div>`;
  const boxes = /** @type {HTMLElement} */ (shadow.querySelector(".boxes"));

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
    } else if (data?.nonce === nonce && data.type === "compose" && !data.on) {
      // The chrome closed its note card; drop the selection and, for the keyboard path, hand
      // focus back to the element the reviewer came from so a Tab lands on the next one.
      closeTarget(data.refocus === true);
    }
  });

  function whenLoaded(then) {
    if (document.readyState === "complete") then();
    else window.addEventListener("load", then, { once: true });
  }

  // Layout can still grow after this script runs, which clamps an early scroll short of where
  // the reviewer was; the second pass at load lands it.
  function restoreScroll(to) {
    const apply = () => {
      const element = to.selector ? readingAnchor(to) : null;
      if (!element) return window.scrollTo(to.x, to.y);
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(to.x, Math.max(0, Math.round(top - to.top)));
    };
    apply();
    whenLoaded(apply);
  }

  /**
   * The element the reviewer was reading, found again in a page the agent has rewritten. The
   * selector is tried first and its text confirms it: a section added above shifts every
   * `:nth-of-type` down one, so the selector alone would silently name a different element.
   */
  function readingAnchor(to) {
    const bySelector = document.querySelector(to.selector);
    if (!to.text || (bySelector && visibleText(bySelector) === to.text)) return bySelector;
    let seen = 0;
    for (const element of document.body.querySelectorAll("*")) {
      if (++seen > MAX_FOCUSABLE) break;
      if (visibleText(element) === to.text) return element;
    }
    return bySelector;
  }

  // Where the reviewer is reading is an element and its offset from the top of the window, not a
  // pixel count: restoring the count alone moves them off their line the moment the agent adds
  // anything above it. The place is the deepest element crossing the top edge of the window -
  // deepest because `main` crosses that edge on every page and starts at the top of every
  // document, so anchoring to it restores the same offset it was supposed to replace.
  function readingPlace() {
    let element = /** @type {Element} */ (document.body);
    for (let depth = 0; depth < 32; depth += 1) {
      const child = [...element.children].find((node) => {
        if (node === host || SKIP.has(tagName(node)) || !node.checkVisibility()) return false;
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > 0;
      });
      if (!child) break;
      element = child;
    }
    while (element !== document.body && !visibleText(element)) element = element.parentElement;
    if (element === document.body) return {};
    return {
      selector: selectorFor(element),
      text: visibleText(element),
      top: Math.round(element.getBoundingClientRect().top),
    };
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
      closeTarget(false);
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

  // An anchor quotes the text the markup carries, never the text CSS painted. `innerText` applies
  // `text-transform`, so a header written `Owner` reached the agent as `OWNER` and matched nothing
  // in the file it was about to edit. Blocks are still spaced apart, because textContent alone runs
  // a row's cells together, and anything the reviewer could not see stays out of a note quoting them.
  function markupText(element) {
    let text = "";
    for (const node of element.childNodes) {
      if (node instanceof Text) text += node.data;
      else if (node instanceof Element && node !== host && !SKIP.has(tagName(node))) {
        if (!node.checkVisibility()) continue;
        text += getComputedStyle(node).display.startsWith("inline")
          ? markupText(node)
          : ` ${markupText(node)} `;
      }
    }
    return text;
  }

  function visibleText(element) {
    return squash(markupText(element)).trim().slice(0, 200);
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

  // The reviewer pointed at something: hand the chrome a target to compose against - the note fields
  // as data, a label to show, and the highlight rects to place the card by - and never the note text,
  // which the chrome alone reads from the reviewer. `open` blocks a second target until the card closes.
  function selectTarget(hit) {
    open = hit;
    outlineRects(hit.rects);
    send({
      type: "target",
      note: {
        selector: selectorFor(hit.element),
        tag: hit.tag,
        text: hit.text,
        ...(hit.target && { target: hit.target }),
      },
      label: label(hit),
      rects: [...hit.rects].map((r) => ({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      })),
      structure: pageOutline(),
    });
  }

  function closeTarget(refocus) {
    if (!open) return;
    const { element } = open;
    open = null;
    outlineRects([]);
    if (refocus && annotate && element.isConnected) element.focus({ preventScroll: true });
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

  document.addEventListener(
    "click",
    (event) => {
      if (!annotate || event.composedPath().includes(host)) return;
      const element = candidate(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      // The click that ends a text drag arrives after the card has opened for the passage.
      if (!open) selectTarget(elementHit(element));
    },
    true,
  );
  document.addEventListener(
    "mouseup",
    () => {
      if (!annotate || open) return;
      const selection = getSelection();
      const hit = selection.isCollapsed ? null : passageHit(selection.getRangeAt(0));
      if (hit) selectTarget(hit);
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
      selectTarget(currentPassage(element) ?? elementHit(element));
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
        send({ type: "scroll", x: window.scrollX, y: window.scrollY, ...readingPlace() });
      });
    },
    { passive: true },
  );

  document.documentElement.append(host);
  send({ type: "ready" });
})();
