import { parse, serialize } from "parse5";

// Windows refuses about 5 in 100000 of Chrome's new loopback connects (docs/ENGINEERING-NOTES.md),
// and nothing asks again for a refused stylesheet, so the page would paint unstyled. This asks once
// more for each link that fails, by putting a copy in its place; a copy that fails stays failed.
const ASK_AGAIN =
  "{const again=new WeakSet();addEventListener('error',(e)=>{const l=e.target;" +
  "if(l instanceof HTMLLinkElement&&!again.has(l)){const c=l.cloneNode();again.add(c);l.replaceWith(c)}},true)}";

/**
 * Appends the SDK script to the artifact's body, and puts the script that asks again for a refused
 * stylesheet first in its head, before any link it watches. Each goes in as a DOM node, so no
 * artifact byte sequence (an unclosed comment, a stray script) can swallow or reshape it, and the
 * artifact's own markup is re-emitted by the parser rather than spliced.
 */
export function injectSdk(html, src) {
  const document = parse(html);
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
  return serialize(document);
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
 * The assets a page loads from outside `rootUrl`, as its markup names them: a relative path that
 * climbs above the root, or an absolute one, both of which the review answers with a 404. Resolved
 * as the browser will, from the page's address `pageUrl` and any <base>; other origins are not ours.
 */
export function assetsOutside(html, rootUrl, pageUrl) {
  const origin = "http://artifact.invalid";
  const elements = [];
  const collect = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) elements.push(child);
      collect(child.content ?? child);
    }
  };
  collect(parse(html));
  const attr = (element, name) => element.attrs.find((a) => a.name === name)?.value;
  let base = new URL(pageUrl, origin);
  const declared = elements.find((e) => e.tagName === "base" && attr(e, "href") !== undefined);
  if (declared) base = new URL(attr(declared, "href"), base);
  const outside = new Set();
  for (const element of elements) {
    const names = LOADS[element.tagName];
    if (!names) continue;
    if (element.tagName === "link") {
      const rel = (attr(element, "rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.some((r) => LOADING_LINKS.has(r))) continue;
    }
    for (const name of names) {
      const value = attr(element, name)?.trim();
      if (!value) continue;
      const refs =
        name === "srcset" ? value.split(",").map((c) => c.trim().split(/\s+/)[0]) : [value];
      for (const ref of refs) {
        if (ref.length > MAX_NAME) continue;
        let url;
        try {
          url = new URL(ref, base);
        } catch {
          continue;
        }
        if (url.origin === origin && !url.pathname.startsWith(rootUrl)) outside.add(ref);
      }
    }
  }
  return [...outside].slice(0, MAX_OUTSIDE);
}
