// Runs inside the sandboxed artifact: finds the element, passage or cell the reviewer points at and hands the note up.
(() => {
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
  // While Annotate is on a control is noted, never activated; Annotate off hands it back to the page.
  const CONTROL = "a[href], button, input, select, textarea, label, summary, [contenteditable]";
  const MEDIA = /^(IMG|SVG|CANVAS|VIDEO)$/;
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

  // One numbered pin per note, drawn from what the chrome sends: where the note points, its number
  // and its state, never its instruction or the agent's reply, which this page must not read. The
  // layer sits in document coordinates, so the pins ride the page's own scroll without a repaint.
  // The shape is the house pin's at the default text size, and the colours its dark roles, as literals:
  // this frame cannot load the chrome's sheets. Every pin and its focus ring carry a dark halo, so
  // they read on a white page and a dark one.
  const PIN = 24;
  // A pin stands GAP clear of the line or box it is beside.
  const GAP = 4;
  // A row shifted clear of a sibling pin tries this many spots before settling for the one that
  // covers least, so the search always ends even when the frame is dense with obstacles.
  const MAX_SHIFT_ATTEMPTS = 200;
  // The widest ring a pin paints around its box, the active one.
  const HALO = 5;
  const MAX_TEXT_NODES = 20000;
  const CONTROLS = "button, input, select, textarea";
  const SOLID = `${CONTROLS}, img, svg, video, canvas, iframe, pre, table`;
  const PIN_STATES = {
    queued: "not sent yet",
    sent: "sent",
    done: "done",
    declined: "declined",
    question: "your agent asked a question",
  };
  const pinHost = document.createElement("div");
  pinHost.style.cssText =
    "all:initial;position:absolute;inset:0 auto auto 0;width:0;height:0;z-index:2147483646";
  const pinRoot = pinHost.attachShadow({ mode: "closed" });
  pinRoot.innerHTML = `
    <style>
      .pin { position: absolute; box-sizing: border-box; display: grid; place-items: center; width: ${PIN}px; height: ${PIN}px; padding: 0; border: 0; border-radius: 50% 50% 50% 2px; background: oklch(0.78 0.12 230); color: oklch(0.165 0.012 260); font: 700 12px/1 system-ui, sans-serif; font-variant-numeric: tabular-nums; cursor: pointer; box-shadow: 0 0 0 2px oklch(0.165 0.012 260); }
      .pin[hidden] { display: none; }
      .pin[data-state="queued"] { background: oklch(0.195 0.012 260); color: oklch(0.663 0.12 230); box-shadow: inset 0 0 0 1px oklch(0.78 0.12 230), 0 0 0 2px oklch(0.165 0.012 260); }
      .pin[data-state="done"] { background: oklch(0.55 0.14 150); color: #fff; }
      .pin[data-state="question"] { background: oklch(0.573 0.124 70); color: #fff; }
      .pin[data-state="declined"] { background: oklch(0.566 0.012 260); color: #fff; }
      .pin[data-active] { box-shadow: 0 0 0 2px oklch(0.165 0.012 260), 0 0 0 5px oklch(0.78 0.12 230); }
      .pin:focus-visible { outline: 2px solid oklch(0.516 0.102 230); outline-offset: 2px; box-shadow: 0 0 0 6px oklch(0.165 0.012 260); }
    </style>
    <div class="pins"></div>`;
  const pinLayer = /** @type {HTMLElement} */ (pinRoot.querySelector(".pins"));
  /** @type {{ n: number, state: string, selector: string, tag: string, text: string, target?: any, button: HTMLButtonElement, anchor: Element | Range | null }[]} */
  let pins = [];
  let activePin = 0;
  let missingSent = "";

  // The parent is the review's wrapper frame, which relays this to the chrome stamped with whether the
  // reviewer's own gesture is live. This page's own origin is opaque, but its address is not.
  const { hostname, port } = new URL(location.href);
  const wrapperOrigin = `http://${hostname === "localhost" ? "127.0.0.1" : "localhost"}:${port}`;
  const send = (message) => parent.postMessage({ ...message, nonce }, wrapperOrigin);
  // SVG elements report a lowercase tagName, so every comparison against the lists above goes through this.
  const tagName = (element) => element.tagName.toUpperCase();
  const squash = (text) => text.replace(/\s+/g, " ");
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  window.addEventListener("message", (event) => {
    // The chrome's messages arrive through the wrapper, served under the loopback name this page is not.
    if (event.source !== parent || event.origin !== wrapperOrigin) return;
    const data = event.data;
    if (data?.type === "init") {
      nonce = data.nonce;
      // A reload replaces the document, so the chrome hands back where the reviewer was reading.
      if (data.scroll) restoreScroll(data.scroll);
      setAnnotate(data.annotate);
      send({ type: "annotate-ok", on: annotate });
      setTextSize(data.textSize);
      // The agent may have rewritten the page, so every note is found again by its anchor.
      setPins(data.pins);
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
    } else if (data?.nonce === nonce && data.type === "pins") {
      setPins(data.pins);
    } else if (data?.nonce === nonce && data.type === "reveal") {
      reveal(data.n);
    } else if (data?.nonce === nonce && data.type === "text-size") {
      setTextSize(data.size);
    }
  });

  // The reviewer's text size, which the chrome sends only to its own Markdown render: one of the
  // house's five steps on <html>, which that page's scales.css turns into its root size.
  function setTextSize(size) {
    if (["s", "m", "l", "xl", "xxl"].includes(size))
      document.documentElement.dataset.textSize = size;
  }

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
  // document, so anchoring to it restores the same offset it was supposed to replace. A sticky
  // or fixed box, and all it holds, is passed over: it crosses that edge wherever the reviewer
  // is, so a header anchored the place to its own top and every reload came back at scroll 0.
  function readingPlace() {
    let element = /** @type {Element} */ (document.body);
    for (let depth = 0; depth < 32; depth += 1) {
      const child = [...element.children].find((node) => {
        if (node === host || SKIP.has(tagName(node)) || !node.checkVisibility()) return false;
        const rect = node.getBoundingClientRect();
        if (rect.height === 0 || rect.bottom <= 0) return false;
        return !/^(sticky|fixed)$/.test(getComputedStyle(node).position);
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

  // The highlight and the pins are ours, not the page's: nothing in them is a target.
  const ours = (event) => event.composedPath().some((node) => node === host || node === pinHost);
  const ownText = (element) =>
    [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  function candidate(node) {
    let element = node instanceof Element ? node : node?.parentElement;
    if (!element || host.contains(element) || pinHost.contains(element)) return null;
    // A chart's bars and labels are one picture, so a note goes on its outermost svg, with the point.
    while (element.ownerSVGElement) element = element.ownerSVGElement;
    element = element.closest(CONTROL) ?? element;
    while (element && SKIP.has(tagName(element))) element = element.parentElement;
    return element;
  }

  const isControl = (element) => element.matches(CONTROL);
  // A field the reviewer types into keeps its keys: no shortcut fires there, and Space stays a space.
  const typing = (element) =>
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT" ||
      (element instanceof HTMLInputElement &&
        !/^(button|submit|reset|checkbox|radio|image|file|color|range)$/.test(element.type)));

  const flows = (display) => display.startsWith("inline") || display === "contents";

  // A block that holds a line of content: text of its own, or an inline run such as a bold phrase.
  // Containers of other blocks are not stops, so a list is its items and a table its cells, and
  // neither is a run of links, controls or pictures, each of which is a stop of its own already.
  function holdsLine(element) {
    const display = getComputedStyle(element).display;
    if (display === "none" || flows(display)) return false;
    return [...element.childNodes].some((node) =>
      node instanceof Text
        ? node.data.trim() !== ""
        : node instanceof Element &&
          !SKIP.has(tagName(node)) &&
          !isControl(node) &&
          !MEDIA.test(tagName(node)) &&
          flows(getComputedStyle(node).display) &&
          node.textContent.trim() !== "",
    );
  }

  // One Tab stop per block of content and per picture, never per inline run: a stop for every
  // element with text of its own put 1,794 stops on an 83 KB report. H and Shift+H jump headings.
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
      if (
        SKIP.has(tagName(element)) ||
        host.contains(element) ||
        (element instanceof SVGElement && element.ownerSVGElement) ||
        element.closest(CONTROL) ||
        element.hasAttribute("tabindex")
      )
        continue;
      if (MEDIA.test(tagName(element)) || holdsLine(element)) {
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

  /** The name a screen reader announces, by the common rules, so an input with no text still has one. */
  function accessibleName(element) {
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id))
      .filter(Boolean);
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName);
    const name =
      labelledBy.map(visibleText).join(" ") ||
      element.getAttribute("aria-label") ||
      [...(element.labels ?? [])].map(visibleText).join(" ") ||
      (field && /^(submit|button|reset)$/.test(element.type) ? element.value : "") ||
      (field ? "" : visibleText(element)) ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      "";
    return clip(squash(name).trim(), 200);
  }

  // A picture's note says which picture and, from a click, where on it: an offset in CSS pixels
  // beside the size it was drawn at, so a point on a chart scales to its viewBox or its data.
  function mediaTarget(element, point) {
    if (!MEDIA.test(tagName(element))) return null;
    const target = { type: "media" };
    if (tagName(element) === "IMG") {
      if (element.hasAttribute("alt")) target.alt = clip(element.alt, 200);
    } else {
      const name = accessibleName(element);
      if (name) target.name = name;
    }
    const src = element.getAttribute("src");
    if (src) target.src = clip(src, 2000);
    if (point) {
      const r = element.getBoundingClientRect();
      target.x = Math.max(0, Math.round(point.x - r.left));
      target.y = Math.max(0, Math.round(point.y - r.top));
      target.width = Math.round(r.width);
      target.height = Math.round(r.height);
    }
    return target;
  }

  // A block of rendered Markdown names its source lines, so a note on it, or on a passage running
  // across several, carries the first and last line beside its selector.
  function sourceLines(from, to) {
    const range = (node) =>
      (node instanceof Element ? node : node.parentElement)
        ?.closest("[data-source-lines]")
        ?.getAttribute("data-source-lines")
        ?.split("-")
        .map(Number);
    const [first] = range(from) ?? [];
    const [, last] = range(to) ?? [];
    return Number.isInteger(first) && Number.isInteger(last) && first <= last
      ? [first, last]
      : undefined;
  }

  function elementHit(element, point) {
    return {
      element,
      tag: element.tagName.toLowerCase(),
      text: visibleText(element),
      lines: sourceLines(element, element),
      target:
        cellTarget(element) ??
        (isControl(element) ? { type: "control", name: accessibleName(element) } : null) ??
        mediaTarget(element, point),
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
    if (!element || host.contains(element) || element.closest(CONTROL)) return null;
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
      lines: sourceLines(range.startContainer, range.endContainer),
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

  // The reviewer pointed at something: hand the chrome a target to compose against - the note fields
  // as data and the highlight rects to place the card by - and never the note text, which the chrome
  // alone reads from the reviewer, nor a label, which the chrome words itself from those fields. `open` blocks a second target until the card closes.
  function selectTarget(hit) {
    open = hit;
    outlineRects(hit.rects);
    send({
      type: "target",
      note: {
        selector: selectorFor(hit.element),
        ...(hit.lines && { lines: hit.lines }),
        tag: hit.tag,
        text: hit.text,
        ...(hit.target && { target: hit.target }),
      },
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

  // Whether the focused element is outlined; not after a note made by mouse, until a key is pressed.
  let focusShown = true;

  function closeTarget(refocus) {
    if (!open) return;
    const { element, pointed, pressed } = open;
    open = null;
    outlineRects([]);
    // Focus goes back however the target was reached, so the next Tab starts from the note; only a
    // target reached by keyboard is outlined there, since after a click the box reads as a
    // selection never made.
    focusShown = !pointed;
    // Not once the reviewer has pressed in the page: this close can land mid-drag, and moving focus
    // then ends the drag, so the passage is recorded cut short or as its whole element.
    if (refocus && annotate && !pressed && element.isConnected)
      element.focus({ preventScroll: true });
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
      // Past the cap only the count is reported, so nothing past it is addressed: on a page of
      // 4,000 sections, addressing every one cost 4.4 s between Enter and the note appearing.
      if (chars > MAX_OUTLINE_CHARS) {
        cut += 1;
        continue;
      }
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

  // A pin keeps its button across updates, so a reviewer whose focus is on one does not lose it
  // when a reply or another note changes the set.
  function setPins(list) {
    if (!Array.isArray(list)) return;
    const kept = new Map(pins.map((pin) => [pin.n, pin.button]));
    pins = list.map((pin) => {
      const button = kept.get(pin.n) ?? pinButton(pin.n);
      kept.delete(pin.n);
      button.dataset.state = pin.state;
      button.setAttribute("aria-label", `Note ${pin.n}, ${PIN_STATES[pin.state] ?? pin.state}`);
      return { ...pin, button, anchor: findAnchor(pin) };
    });
    for (const button of kept.values()) button.remove();
    pinLayer.append(...pins.map((pin) => pin.button).filter((button) => !button.isConnected));
    activate(activePin);
    placePins();
  }

  function pinButton(n) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pin";
    button.textContent = String(n);
    button.addEventListener("click", () => {
      activate(n);
      send({ type: "pin", n });
    });
    return button;
  }

  function activate(n) {
    activePin = n;
    for (const pin of pins) pin.button.toggleAttribute("data-active", pin.n === n);
  }

  /** Brings a note's target to the middle of the window, or its top when it is taller than that. */
  function reveal(n) {
    activate(n);
    const anchor = pins.find((pin) => pin.n === n)?.anchor;
    if (!anchor) return;
    const element = anchor instanceof Range ? anchor.startContainer.parentElement : anchor;
    const tall = element.getBoundingClientRect().height > innerHeight * 0.8;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({
      block: tall ? "start" : "center",
      inline: "nearest",
      behavior: still ? "instant" : "smooth",
    });
  }

  function query(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  /**
   * The element a note was left on, found again in a page the agent may have rewritten: the
   * selector first, confirmed by tag, text and cell, then the first element that matches all three.
   * A note whose text the agent changed stays on the element its selector still names.
   */
  function findAnchor(pin) {
    if (pin.tag === "text") return passageAnchor(pin);
    const cell = pin.target?.type === "table-cell" ? pin.target : null;
    const fits = (element) => {
      if (element.tagName.toLowerCase() !== pin.tag || visibleText(element) !== pin.text)
        return false;
      const named = cell && cellTarget(element);
      return !cell || (named?.row === cell.row && named?.column === cell.column);
    };
    const bySelector = query(pin.selector);
    if (bySelector && fits(bySelector)) return bySelector;
    let seen = 0;
    for (const element of document.body.querySelectorAll("*")) {
      if (++seen > MAX_FOCUSABLE) break;
      if (fits(element)) return element;
    }
    return bySelector;
  }

  /**
   * A passage found again: in the element its selector names if it is still there, else in the
   * smallest element that holds it, at the occurrence whose surrounding text matches and which
   * sits nearest the offset it was taken at. Falls back to the element when the words are gone.
   */
  function passageAnchor(pin) {
    const words = String(pin.text ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const bySelector = query(pin.selector);
    if (words.length === 0) return bySelector;
    const pattern = new RegExp(
      words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
      "g",
    );
    const { start = 0, before = "", after = "" } = pin.target ?? {};
    const best = (element) => {
      let found = null;
      for (const match of element.textContent.matchAll(pattern)) {
        const whole = element.textContent;
        const end = match.index + match[0].length;
        const context =
          squash(whole.slice(0, match.index)).endsWith(before) &&
          squash(whole.slice(end)).startsWith(after);
        const score = (context ? 0 : 1e9) + Math.abs(match.index - start);
        if (!found || score < found.score) found = { start: match.index, end, score };
      }
      return found;
    };
    let element = bySelector && best(bySelector) ? bySelector : null;
    if (!element) {
      let seen = 0;
      for (const node of document.body.querySelectorAll("*")) {
        if (++seen > MAX_FOCUSABLE) break;
        if (SKIP.has(tagName(node)) || host.contains(node)) continue;
        pattern.lastIndex = 0;
        const size = node.textContent.length;
        if ((!element || size < element.textContent.length) && pattern.test(node.textContent))
          element = node;
      }
    }
    const hit = element && best(element);
    return (hit && rangeAt(element, hit.start, hit.end)) ?? bySelector;
  }

  /** A range over characters `start` to `end` of the element's text content. */
  function rangeAt(element, start, end) {
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = /** @type {Text} */ (node).data.length;
      if (!started && start <= offset + length) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && end <= offset + length) {
        range.setEnd(node, end - offset);
        return range;
      }
      offset += length;
    }
    return null;
  }

  // A pin sits like a footnote mark on the top right of the first line of what it marks, so it
  // reads as attached to the words without covering them; a target with no text of its own, such
  // as an image or a table, gets its box. The first line is every box on it, so a paragraph that
  // opens with a code chip is marked where its line ends rather than where the chip does, and a
  // control by its box, which is what the reviewer sees of it. Where that spot would cover words, a
  // control, a picture, a code block or another pin, as it does between paragraphs closer than a pin
  // is tall, the pin moves beside the line's end, before its start, under its end, then to the right
  // of the block; failing all of those, to whichever covers least.
  // A table cell has no room above its words, so its pin stays inside the cell, off the rows around it.
  // Every note on one target is placed as one row `width` wide, so a second pin stands beside the first.
  const elementFor = (anchor) => {
    const node = anchor instanceof Range ? anchor.commonAncestorContainer : anchor;
    return node instanceof Element ? node : node.parentElement;
  };

  // A box of the target's own, or one holding it, is a spot's ground, not something it covers.
  const overlapArea = (spot, width, avoid, element) => {
    let area = 0;
    for (const { rect, owner } of avoid) {
      if (owner && (owner === element || owner.contains(element) || element.contains(owner)))
        continue;
      const w = Math.min(spot.left + width, rect.right) - Math.max(spot.left, rect.left);
      const h = Math.min(spot.top + PIN, rect.bottom) - Math.max(spot.top, rect.top);
      if (w > 0.5 && h > 0.5) area += w * h;
    }
    return area;
  };

  function pinSpot(anchor, avoid, bounds, width) {
    let rects;
    if (anchor instanceof Range) rects = [...anchor.getClientRects()];
    else if (ownText(anchor) && !anchor.matches(CONTROLS)) {
      const range = document.createRange();
      range.selectNodeContents(anchor);
      rects = [...range.getClientRects()];
    } else rects = [anchor.getBoundingClientRect()];
    rects = rects.filter((r) => r.width > 0 && r.height > 0);
    const [first] = rects;
    if (!first) return null;
    const line = rects.filter((r) => {
      const middle = r.top + r.height / 2;
      return middle > first.top && middle < first.bottom;
    });
    const right = Math.max(...line.map((r) => r.right));
    const lineTop = Math.min(...line.map((r) => r.top));
    const lineBottom = Math.max(...line.map((r) => r.bottom));
    const element = elementFor(anchor);
    const cell = element?.closest("td, th");
    if (cell) {
      // Beside the words rather than above them, so it clears them by its widest ring, 5 px.
      const box = cell.getBoundingClientRect();
      return {
        left: Math.max(box.left, Math.min(right + 5, box.right - width)),
        top: Math.max(box.top, Math.min(lineTop - PIN, box.bottom - PIN)),
      };
    }
    // Level with the line's middle, or with the top of a box taller than a pin.
    const beside = lineTop - (PIN - Math.min(lineBottom - lineTop, PIN)) / 2;
    const candidates = [
      // The pin's point is its lower left corner, so it stands on the line's top right corner.
      // Above the element's own box, so a heading's rule or a block's padding stays clear of it.
      {
        left: right + 1,
        top:
          (anchor instanceof Range
            ? lineTop
            : Math.min(lineTop, element.getBoundingClientRect().top)) - PIN,
      },
      { left: right + GAP, top: beside },
      { left: Math.min(...line.map((r) => r.left)) - width - GAP, top: beside },
      { left: right - width, top: lineBottom + GAP },
      { left: element.getBoundingClientRect().right + GAP, top: beside },
    ].map(({ left, top }) => ({
      left: Math.min(Math.max(left, bounds.left), bounds.right - width),
      top: Math.max(top, bounds.top),
    }));
    let best = null;
    for (const spot of candidates) {
      const area = overlapArea(spot, width, avoid, element);
      if (area === 0) return spot;
      if (!best || area < best.area) best = { ...spot, area };
    }
    return best;
  }

  // What a pin must not paint over, in viewport coordinates: every run of the page's words, and the
  // boxes of controls, pictures, code blocks and tables, each with the element that draws it. A
  // word carries no owner, so a pin keeps off its own target's words too.
  function obstacles() {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let text = walker.nextNode(); text && ++seen <= MAX_TEXT_NODES; text = walker.nextNode()) {
      if (!(/** @type {Text} */ (text).data.trim())) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const rect of range.getClientRects())
        if (rect.width > 0 && rect.height > 0) found.push({ rect, owner: null });
    }
    for (const owner of document.body.querySelectorAll(SOLID)) {
      const rect = owner.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) found.push({ rect, owner });
    }
    return found;
  }

  const attached = (anchor) =>
    anchor instanceof Range
      ? !anchor.collapsed && anchor.startContainer.isConnected
      : anchor.isConnected;

  function placePins() {
    const origin = pinHost.getBoundingClientRect();
    // Inside the frame by the pin's halo, so no edge of the frame cuts its ring.
    const bounds = {
      left: HALO,
      right: document.documentElement.clientWidth - HALO,
      top: origin.top + HALO,
    };
    const avoid = obstacles();
    const placed = [];
    const missing = [];
    for (const pin of pins) {
      if (!pin.anchor || !attached(pin.anchor)) pin.anchor = findAnchor(pin);
    }
    // The notes on one element, in number order, form one row and are placed together, and so does
    // a passage that starts on that element's first line, which would otherwise want the same spot.
    const firstTop = (target) => target.getClientRects()[0]?.top;
    const rowOf = (pin) => {
      if (!(pin.anchor instanceof Range)) return pin.anchor ?? pin;
      const node = pin.anchor.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const whole = document.createRange();
      whole.selectNodeContents(element);
      return Math.abs(firstTop(pin.anchor) - firstTop(whole)) < 1 ? element : pin;
    };
    const rows = new Map();
    for (const pin of pins) {
      const key = rowOf(pin);
      rows.set(key, [...(rows.get(key) ?? []), pin]);
    }
    for (const row of rows.values()) {
      const { anchor } = row[0];
      const width = row.length * PIN + (row.length - 1) * GAP;
      const spot = anchor && pinSpot(anchor, avoid, bounds, width);
      for (const pin of row) pin.button.hidden = !spot;
      if (!spot) {
        missing.push(...row.map((pin) => pin.n));
        continue;
      }
      const naturalX = spot.left - origin.left;
      let x = naturalX;
      let y = spot.top - origin.top;
      // Two rows on one spot stand side by side rather than one hiding the other, and a row with
      // no room left beside it in the frame starts again under it, at its own natural column.
      const right = bounds.right - origin.left - width;
      const element = elementFor(anchor);
      const areaAt = (cx, cy) =>
        placed.some((p) => p.x - width < cx && cx < p.x + p.width && Math.abs(p.y - cy) < PIN)
          ? Infinity
          : overlapArea({ left: cx + origin.left, top: cy + origin.top }, width, avoid, element);
      let bestX = x;
      let bestY = y;
      let bestArea = areaAt(x, y);
      for (let attempt = 0; bestArea > 0 && attempt < MAX_SHIFT_ATTEMPTS; attempt++) {
        if (x + PIN + GAP <= right) x += PIN + GAP;
        else {
          x = naturalX;
          y += PIN + GAP;
        }
        const area = areaAt(x, y);
        if (area < bestArea) {
          bestArea = area;
          bestX = x;
          bestY = y;
        }
      }
      x = bestX;
      y = bestY;
      placed.push({ x, y, width });
      // A placed row is in the way of the next one, as words are.
      avoid.push({ rect: new DOMRect(x + origin.left, y + origin.top, width, PIN), owner: null });
      for (const [i, pin] of row.entries()) {
        pin.button.style.left = `${x + i * (PIN + GAP)}px`;
        pin.button.style.top = `${y}px`;
      }
    }
    missing.sort((a, b) => a - b);
    // The chrome says in the margin which notes no longer have anything on the page to point at.
    const report = JSON.stringify(missing);
    if (report !== missingSent) {
      missingSent = report;
      send({ type: "placed", missing });
    }
  }

  // Layout moves under the pins when the window resizes, the page grows, fonts or images arrive,
  // or a scrolling box inside the page scrolls; the document's own scroll needs nothing.
  let placing = false;
  const replace = () => {
    if (placing || pins.length === 0) return;
    placing = true;
    requestAnimationFrame(() => {
      placing = false;
      placePins();
    });
  };
  window.addEventListener("resize", replace);
  document.addEventListener("scroll", (event) => event.target !== document && replace(), {
    capture: true,
    passive: true,
  });
  new ResizeObserver(replace).observe(document.documentElement);
  document.fonts?.ready.then(replace);
  whenLoaded(replace);

  // Every listener below is on the window in the capture phase, ahead of any the page adds to an
  // element or the document, so in Annotate mode a click notes a control and the page never sees it.
  // This one comes first, so the press is counted on a control as well; see closeTarget.
  window.addEventListener("pointerdown", () => open && (open.pressed = true), true);
  window.addEventListener(
    "click",
    (event) => {
      if (!annotate || ours(event)) return;
      const element = candidate(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // The click that ends a text drag arrives after the card has opened for the passage.
      if (!open)
        selectTarget({
          ...elementHit(element, { x: event.clientX, y: event.clientY }),
          pointed: true,
        });
    },
    true,
  );
  window.addEventListener(
    "mouseup",
    () => {
      if (!annotate || open) return;
      const selection = getSelection();
      const hit = selection.isCollapsed ? null : passageHit(selection.getRangeAt(0));
      if (hit) selectTarget({ ...hit, pointed: true });
    },
    true,
  );
  // A press on a control would focus it, open it or start a drag, and the page may act on the
  // press itself; in Annotate mode the press belongs to the note, so none of that happens.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick"]) {
    window.addEventListener(
      type,
      (event) => {
        if (!annotate || ours(event)) return;
        const element = candidate(event.target);
        if (!element || !isControl(element)) return;
        event.stopImmediatePropagation();
        if (type !== "mousedown") return;
        event.preventDefault();
        // Cancelling the press also keeps focus from entering this frame, and the chrome hears a
        // target only while the frame holds the reviewer's focus, so the frame takes it itself.
        window.focus();
      },
      true,
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!annotate || open || ours(event) || event.ctrlKey || event.metaKey || event.altKey)
        return;
      const element = candidate(document.activeElement);
      if (!element || element === document.body) return;
      const control = isControl(element);
      if (!control && event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        extendPassage(element, event.key === "ArrowRight" ? "forward" : "backward");
      } else if (event.key === "Enter" || (event.key === " " && !typing(element))) {
        selectTarget((!control && currentPassage(element)) || elementHit(element));
      } else {
        if (event.key === "Escape" && !control) {
          if (getSelection().rangeCount > 0) getSelection().collapseToStart();
          outline(element);
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  // The review's own keys, listed in the chrome's help line. They bubble, so a key the page has
  // already handled is left alone, and none fires in a field the reviewer is typing in. A and the
  // send key are the chrome's to act on, which it does only under the reviewer's own key press.
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || typing(event.target)) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key === "Enter") send({ type: "key", action: "send" });
    else if (command) return;
    else if (event.key === "a") send({ type: "key", action: "annotate" });
    else if (event.key.toLowerCase() === "h" && annotate && !open)
      jumpHeading(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  });

  /** Moves focus to the next heading after the focused element, or the one before it. */
  function jumpHeading(direction) {
    const from = document.activeElement ?? document.body;
    const headings = focusable.filter((e) => /^H[1-6]$/.test(tagName(e)) && e.checkVisibility());
    const ahead = (h) =>
      !h.contains(from) &&
      Boolean(from.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
    const to =
      direction > 0
        ? headings.find(ahead)
        : headings.findLast((h) => h !== from && !h.contains(from) && !ahead(h));
    to?.focus();
  }
  document.addEventListener("mouseover", (event) => {
    if (annotate && !open) outline(candidate(event.target));
  });
  // The highlight is drawn in window coordinates, so a scroll or a resize draws it again where its
  // element now is, rather than leaving a box over whatever moved under the old spot.
  const reoutline = () => {
    if (!annotate) return;
    if (!open) outline(focusShown ? candidate(document.activeElement) : null);
    else if (open.tag !== "text") outline(open.element);
  };
  window.addEventListener("scroll", reoutline, { capture: true, passive: true });
  window.addEventListener("resize", reoutline);
  document.addEventListener("focusin", (event) => {
    if (annotate && !open && focusShown) outline(candidate(event.target));
  });
  // A key in the page is the reviewer using the keyboard again, so focus is outlined from here on.
  window.addEventListener("keydown", () => (focusShown = true), true);

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

  document.documentElement.append(pinHost, host);
  send({ type: "ready" });
})();
