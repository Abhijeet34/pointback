import { parse, serialize } from "parse5";

// Windows refuses about 5 in 100000 of Chrome's new loopback connects (docs/ENGINEERING-NOTES.md),
// and nothing asks again for a refused stylesheet, so the page would paint unstyled. This asks once
// more for each link that fails, by putting a copy in its place; a copy that fails stays failed.
const ASK_AGAIN =
  "{const again=new WeakSet();addEventListener('error',(e)=>{const l=e.target;" +
  "if(l instanceof HTMLLinkElement&&!again.has(l)){const c=l.cloneNode();again.add(c);l.replaceWith(c)}},true)}";

/**
 * Parses a page once for both of the daemon's uses of it: the page as served, and what it loads, for
 * `assetsOutside`. The SDK script goes last in its body and the script that asks again for a refused
 * stylesheet first in its head, before any link it watches. Each goes in as a DOM node, so no
 * artifact byte sequence (an unclosed comment, a stray script) can swallow or reshape it, and the
 * artifact's own markup is re-emitted by the parser rather than spliced.
 */
export function preparePage(html, src) {
  const document = parse(html);
  const loads = loadsOf(document);
  const script = (parentNode, attrs, text) => {
    const node = {
      nodeName: "script",
      tagName: "script",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      attrs,
      childNodes: [],
      parentNode,
    };
    if (text) node.childNodes.push({ nodeName: "#text", value: text, parentNode: node });
    return node;
  };
  const head = find(document, "head");
  head.childNodes.unshift(script(head, [], ASK_AGAIN));
  const body = find(document, "body");
  body.childNodes.push(script(body, [{ name: "src", value: src }]));
  return { html: serialize(document), loads };
}

function find(node, name) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === name) return child;
    const found = find(child, name);
    if (found) return found;
  }
  return null;
}

// What a page loads rather than links to, by element and attribute. A <link> loads only for these
// relations; the rest of its kind, like an <a>, is somewhere to go, not something the page needs.
const LOADS = {
  link: ["href"],
  script: ["src"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
};
const LOADING_LINKS = new Set(["stylesheet", "icon", "preload", "modulepreload", "manifest"]);
// The names are the page's own text and reach the chrome, so a long one is dropped, not shown.
const MAX_OUTSIDE = 20;
const MAX_NAME = 120;

/**
 * What a page loads, as it names it, and the <base> it resolves against, if any: from its markup,
 * and from the CSS in its <style> elements and style attributes. A stylesheet link is marked
 * `sheet`, so `assetsOutside` can read what that sheet loads in turn.
 */
function loadsOf(document) {
  const elements = [];
  const collect = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) elements.push(child);
      collect(child.content ?? child);
    }
  };
  collect(document);
  const attr = (element, name) => element.attrs.find((a) => a.name === name)?.value;
  const base = elements.find((e) => e.tagName === "base" && attr(e, "href") !== undefined);
  const refs = [];
  for (const element of elements) {
    const style = attr(element, "style");
    if (style) refs.push(...cssRefs(style));
    if (element.tagName === "style")
      refs.push(...cssRefs(element.childNodes.map((text) => text.value ?? "").join("")));
    const names = LOADS[element.tagName];
    if (!names) continue;
    let sheet = false;
    if (element.tagName === "link") {
      const rel = (attr(element, "rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.some((r) => LOADING_LINKS.has(r))) continue;
      sheet = rel.includes("stylesheet");
    }
    for (const name of names) {
      const value = attr(element, name)?.trim();
      if (!value) continue;
      const named =
        name === "srcset" ? value.split(",").map((c) => c.trim().split(/\s+/)[0]) : [value];
      refs.push(...named.map((ref) => ({ ref, sheet })));
    }
  }
  return { base: base && attr(base, "href"), refs };
}

/** What CSS loads: each url(), quoted or not, and each sheet it imports; a comment names nothing. */
function cssRefs(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const refs = [];
  for (const [, imported, , ref] of text.matchAll(/(@import\s+)?url\(\s*(["']?)(.*?)\2\s*\)/gi))
    if (ref.trim()) refs.push({ ref: ref.trim(), sheet: Boolean(imported) });
  for (const [, , ref] of text.matchAll(/@import\s+(["'])(.*?)\1/gi))
    if (ref.trim()) refs.push({ ref: ref.trim(), sheet: true });
  return refs;
}

/**
 * The assets a page loads from outside `rootUrl`, from its `loads` as `preparePage` read them: a
 * relative path that climbs above the root, or an absolute one, both of which the review answers
 * with a 404. Resolved as the browser will, from the page's address `pageUrl` and any <base>; other
 * origins are not ours. A stylesheet inside the root is read through `readSheet`, given its path
 * under the root and answering its text or null, and what it loads is resolved from its own address.
 * @param {{ base?: string, refs: { ref: string, sheet: boolean }[] }} loads
 * @param {string} rootUrl
 * @param {string} pageUrl
 * @param {(path: string) => string | null} [readSheet]
 */
export function assetsOutside({ base, refs }, rootUrl, pageUrl, readSheet = () => null) {
  const origin = "http://artifact.invalid";
  let page = new URL(pageUrl, origin);
  if (base !== undefined) page = new URL(base, page);
  const outside = new Set();
  const read = new Set();
  // Grows as each sheet is read, and a sheet is read once, so an @import cycle ends.
  const queue = refs.map((load) => ({ ...load, from: page }));
  for (const { ref, sheet, from } of queue) {
    if (ref.length > MAX_NAME) continue;
    let url;
    try {
      url = new URL(ref, from);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (!url.pathname.startsWith(rootUrl)) outside.add(ref);
    else if (sheet && !read.has(url.pathname)) {
      read.add(url.pathname);
      const css = readSheet(url.pathname.slice(rootUrl.length));
      if (css !== null) queue.push(...cssRefs(css).map((load) => ({ ...load, from: url })));
    }
  }
  return [...outside].slice(0, MAX_OUTSIDE);
}
