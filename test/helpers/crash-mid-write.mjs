// Run as its own process: keeps one unsent note on each review it is given, then is killed inside
// the next state write, after the temp file is on disk and before the rename that would replace the
// session's file. That gap is the one place an atomic write can be cut short.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { serve } from "../../src/server.js";

const [stateDir, ...files] = process.argv.slice(2);
let armed = false;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (armed) {
    // Written synchronously: stdout on a pipe is asynchronous on macOS, and SIGKILL drops the queue.
    fs.writeSync(1, `killed before ${basename(String(from))} replaced ${basename(String(to))}\n`);
    process.kill(process.pid, "SIGKILL");
  }
  return rename(from, to);
};
syncBuiltinESMExports();

const daemon = await serve({ stateDir, port: 0, idleMs: 60_000 });
const post = (path, body) =>
  fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const note = (prompt) => ({ prompt, selector: "h1", tag: "h1", text: "x" });

const keys = [];
for (const file of files) {
  const { key } = await post("/api/sessions", { file });
  await post(`/api/${key}/drafts`, { draft: note(`kept on ${basename(file)}`) });
  keys.push(key);
}
armed = true;
await post(`/api/${keys[0]}/drafts`, { draft: note("never written") });
fs.writeSync(1, "the write completed, so nothing was interrupted\n");
await daemon.close();
