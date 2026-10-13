import { basename, extname } from "node:path";
import MarkdownIt from "markdown-it";

const KINDS = { ".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown" };

/** What a review can show: an HTML page, Markdown rendered into one, or null for anything else. */
export const artifactKind = (file) => KINDS[extname(file).toLowerCase()] ?? null;

// Raw HTML stays on: the rendered page runs in the same opaque-origin sandbox as any HTML artifact.
const md = new MarkdownIt({ html: true });
const LINES = "data-source-lines";

// A fenced block's own renderer puts attributes on its <code>, but the block a reviewer points at
// is the <pre> around it, so the lines go there.
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, index, ...rest) =>
  fence(tokens, index, ...rest).replace(/^<pre/, `<pre ${LINES}="${tokens[index].meta.lines}"`);
// A wide table scrolls in a box of its own (markdown.css), so a phone never scrolls the page sideways.
md.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div class="table">${self.renderToken(tokens, index, options)}`;
md.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>`;

// Inline code and the characters touching it, such as "(" before or ")," after, are one chip that
// wraps whole (markdown.css); apart, a line could end on the "(" with its code on the next.
const codeInline = md.renderer.rules.code_inline;
const isCode = (token) => token?.type === "code_inline";
md.renderer.rules.text = (tokens, index) => {
  let text = tokens[index].content;
  let head = "";
  let tail = "";
  if (isCode(tokens[index - 1])) {
    const [run] = text.match(/^\S*/);
    head = `${md.utils.escapeHtml(run)}</span>`;
    text = text.slice(run.length);
  }
  if (isCode(tokens[index + 1])) {
    const [run] = text.match(/\S*$/);
    tail = `<span class="chip">${md.utils.escapeHtml(run)}`;
    text = text.slice(0, text.length - run.length);
  }
  return head + md.utils.escapeHtml(text) + tail;
};
md.renderer.rules.code_inline = (tokens, index, ...rest) => {
  const open = tokens[index - 1]?.type === "text" ? "" : '<span class="chip">';
  const close = tokens[index + 1]?.type === "text" ? "" : "</span>";
  return open + codeInline(tokens, index, ...rest) + close;
};

/** The daemon's own stylesheets every rendered page loads, which no root needs to hold. */
export const MARKDOWN_STYLES = [
  "/house/brand.tokens.css",
  "/house/roles.css",
  "/house/scales.css",
  "/markdown.css",
];

/**
 * A Markdown file as a page in the house reading styles. Every block carries its source lines,
 * 1-based and inclusive, so a note on it can say where in the file it points.
 */
export function renderMarkdown(source, file) {
  const lines = source.split("\n");
  const tokens = md.parse(source, {});
  for (const token of tokens) {
    if (!token.map || !(token.nesting === 1 || token.type === "fence" || token.type === "hr"))
      continue;
    // A block's map runs to the line after it and takes in the blank lines that end a list.
    let [start, end] = token.map;
    while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
    const range = `${start + 1}-${end}`;
    if (token.type === "fence") token.meta = { lines: range };
    else token.attrSet(LINES, range);
  }
  const title = md.utils.escapeHtml(basename(file));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
${MARKDOWN_STYLES.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
</head>
<body><main>
${md.renderer.render(tokens, md.options, {})}</main></body>
</html>
`;
}
