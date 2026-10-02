// What one mutation costs on disk as the daemon holds more sessions. Every file save on a review
// bumps its revision and writes state through, so this times exactly that, `fileChanged`, and
// counts the bytes it hands the filesystem. Run: npm run bench [-- --notes 200 --writes 50]
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { SessionStore } from "../src/session-store.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "1,4,16,64" },
    notes: { type: "string", default: "200" },
    writes: { type: "string", default: "50" },
  },
});
const notesPerSession = Number(values.notes);
const writes = Number(values.writes);

// Counted at the filesystem call rather than by reading a known file back, so the number holds
// whatever layout the store writes.
let written = 0;
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, data, options) => {
  written += Buffer.byteLength(data);
  return realWrite(file, data, options);
};
syncBuiltinESMExports();

// About the size of a real note: a sentence or two of instruction, and the text it points at.
const note = (i) => ({
  prompt: `Note ${i}: tighten this paragraph and keep the figures it cites. `.repeat(4),
  selector: `main > section:nth-of-type(${i}) > p`,
  tag: "p",
  text: "The quarterly figures below are provisional until the audit closes.",
});

function measure(count) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-bench-"));
  try {
    const store = new SessionStore(dir);
    const keys = [];
    for (let s = 0; s < count; s += 1) {
      const artifact = join(dir, `page-${s}.html`);
      writeFileSync(artifact, "<p>page</p>");
      const { key } = store.open(artifact);
      for (let n = 0; n < notesPerSession; n += 50)
        store.queue(
          key,
          Array.from({ length: Math.min(50, notesPerSession - n) }, (_, i) => note(n + i)),
        );
      keys.push(key);
    }
    const times = [];
    written = 0;
    for (let w = 0; w < writes; w += 1) {
      const start = performance.now();
      store.fileChanged(keys[w % keys.length]);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { median: times[times.length >> 1], bytes: written / writes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`| sessions held | notes each | bytes per save | median ms per save |`);
console.log(`|---:|---:|---:|---:|`);
for (const count of values.sessions.split(",").map(Number)) {
  const { median, bytes } = measure(count);
  console.log(
    `| ${count} | ${notesPerSession} | ${Math.round(bytes).toLocaleString("en")} | ${median.toFixed(2)} |`,
  );
}
