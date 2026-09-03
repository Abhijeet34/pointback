import { parse, serialize } from "parse5";

/**
 * Appends the SDK script to the artifact's body as a DOM node, so no artifact
 * byte sequence (an unclosed comment, a stray script) can swallow or reshape it,
 * and the artifact's own markup is re-emitted by the parser rather than spliced.
 */
export function injectSdk(html, src) {
  const document = parse(html);
  const body = findBody(document);
  body.childNodes.push({
    nodeName: "script",
    tagName: "script",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    attrs: [{ name: "src", value: src }],
    childNodes: [],
    parentNode: body,
  });
  return serialize(document);
}

function findBody(node) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === "body") return child;
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}
