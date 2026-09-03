import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "parse5";
import { injectSdk } from "../src/inject.js";

test("the SDK script becomes the last child of body", () => {
  const out = injectSdk("<!doctype html><html><body><p>hi</p></body></html>", "/sdk.js");
  assert.match(out, /<p>hi<\/p><script src="\/sdk.js"><\/script><\/body>/);
  assert.equal(out.match(/<script/g).length, 1);
});

test("a fragment with no body still gets one, and the script inside it", () => {
  const out = injectSdk("<h1>bare</h1>", "/sdk.js");
  assert.match(out, /<body><h1>bare<\/h1><script src="\/sdk.js"><\/script><\/body>/);
});

test("an unclosed comment or script in the artifact cannot swallow the injected tag", () => {
  for (const html of ["<body><p>x</p><!-- never closed", "<body><script>var a = '<"]) {
    const out = injectSdk(html, "/sdk.js");
    assert.match(out, /<script src="\/sdk.js"><\/script>/, html);
  }
});

test("the src attribute is serialised, never spliced", () => {
  const src = `/sdk.js"><script>alert(1)</script>`;
  const out = injectSdk("<body></body>", src);
  const scripts = [];
  const walk = (node) => {
    if (node.nodeName === "script") scripts.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(out));
  assert.equal(scripts.length, 1, "the hostile value produced no second element");
  assert.equal(scripts[0].attrs.find((a) => a.name === "src").value, src);
});
