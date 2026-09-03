// The chrome page: bootstraps the session, hosts the sandboxed artifact, and keeps the notes margin.
const key = location.pathname.split("/").pop();
const token = location.hash.slice(1);
const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const marks = document.getElementById("marks");
const statusLine = document.getElementById("status");
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const annotateSwitch = document.getElementById("annotate");
const pendingKey = `pending:${key}`;

let nonce = "";
let annotate = false;
let pending = readPending();
let chat = [];

const api = (method, path, body) =>
  fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `${res.status}`);
    return json;
  });

async function boot() {
  const app = await fetch("/health").then((r) => r.json());
  document.getElementById("appName").textContent = app.app;
  let session;
  try {
    session = await api("GET", `/api/${key}/session`);
  } catch {
    statusLine.textContent =
      "This link no longer works. Run the command on the file again to get a fresh one.";
    return;
  }
  document.title = `${session.fileName} · ${app.app}`;
  document.getElementById("fileName").textContent = session.fileName;
  chat = session.chat;
  frame.src = session.artifactUrl;
  render();
}

function readPending() {
  try {
    return JSON.parse(sessionStorage.getItem(pendingKey) ?? "[]");
  } catch {
    return [];
  }
}

function savePending() {
  sessionStorage.setItem(pendingKey, JSON.stringify(pending));
}

function render() {
  marks.replaceChildren(
    ...chat.map((entry) => mark(entry, true)),
    ...pending.map((entry) => mark(entry, false)),
  );
  marks.scrollTop = marks.scrollHeight;
  sendButton.disabled = pending.length === 0;
  sendButton.textContent =
    pending.length === 0
      ? "Send to agent"
      : `Send ${pending.length} ${pending.length === 1 ? "note" : "notes"} to agent`;
  statusLine.textContent =
    chat.length === 0 && pending.length === 0
      ? "Turn on Annotate, then click an element or Tab to it and press Enter to leave a note."
      : pending.length === 0
        ? "Every note has been sent."
        : `${pending.length} not sent yet.`;
}

function mark(entry, sent) {
  const li = document.createElement("li");
  li.className = sent ? "mark sent" : "mark";
  const target = document.createElement("div");
  target.className = "mark-target";
  const tag = document.createElement("span");
  tag.className = "mark-tag";
  tag.textContent = entry.target.tag;
  const text = document.createElement("span");
  text.className = "mark-text";
  text.textContent = entry.target.text;
  target.append(tag, text);
  const note = document.createElement("p");
  note.className = "mark-note";
  note.textContent = entry.prompt;
  li.append(target, note);
  if (!sent) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mark-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove this note");
    remove.addEventListener("click", () => {
      pending = pending.filter((item) => item !== entry);
      savePending();
      render();
    });
    li.append(remove);
  }
  return li;
}

function post(message) {
  // The artifact has an opaque origin, so "*" is the only target that can name it.
  frame.contentWindow?.postMessage({ ...message, nonce }, "*");
}

window.addEventListener("message", (event) => {
  // Only the artifact frame's own window, which is always opaque-origin, is heard.
  if (event.source !== frame.contentWindow || event.origin !== "null") return;
  const data = event.data;
  if (data?.type === "ready") {
    nonce = crypto.randomUUID();
    post({ type: "init", annotate });
    document.body.dataset.ready = "1";
    return;
  }
  if (data?.nonce !== nonce) return;
  if (data.type === "queue") {
    pending.push({ prompt: data.prompt.prompt, target: data.prompt });
    savePending();
    render();
  }
});

annotateSwitch.addEventListener("click", () => {
  annotate = !annotate;
  annotateSwitch.setAttribute("aria-checked", String(annotate));
  post({ type: "annotate", on: annotate });
});

document.getElementById("sendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending.length === 0) return;
  sendButton.disabled = true;
  try {
    const prompts = pending.map((entry) => ({ ...entry.target, prompt: entry.prompt }));
    await api("POST", `/api/${key}/prompts`, { prompts });
    pending = [];
    savePending();
    chat = (await api("GET", `/api/${key}/session`)).chat;
    render();
  } catch (error) {
    statusLine.textContent = `Could not send: ${error.message}`;
    sendButton.disabled = false;
  }
});

boot();
