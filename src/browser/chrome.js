// The chrome page: bootstraps the session, hosts the sandboxed artifact, keeps the notes margin,
// and stays on the server's event stream so the page, the agent's presence and the end of the
// review are never something the reviewer has to discover by trying an action that no longer works.
const key = location.pathname.split("/").pop();
const token = location.hash.slice(1);
const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const marks = document.getElementById("marks");
const statusLine = document.getElementById("status");
const notice = document.getElementById("notice");
const noticeText = document.getElementById("noticeText");
const takeOverButton = /** @type {HTMLButtonElement} */ (document.getElementById("takeOver"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const annotateSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotate"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const endDialog = /** @type {HTMLDialogElement} */ (document.getElementById("endDialog"));
const endGo = document.getElementById("endGo");
const endDiscard = /** @type {HTMLButtonElement} */ (document.getElementById("endDiscard"));
const presencePill = document.getElementById("presence");
const presenceText = document.getElementById("presenceText");
const pendingKey = `pending:${key}`;

const PRESENCE = {
  waiting: ["Not listening", "Your agent is not connected. It will pick your notes up next time."],
  listening: ["Listening", "Your agent is connected and waiting for your notes."],
  working: ["Working", "Your agent took your last notes and is working on them."],
};
const RETRIES = 5;

let nonce = "";
let annotate = false;
let chat = [];
let session = null;
let revision = 0;
let shownRevision = -1;
let presence = { state: "waiting" };
let ended = null;
let current = true;
let liveReload = true;
let connection = "live";
let editing = false;
let deferredReload = false;
let lastScroll = null;
let workingTimer = null;
let stream = null;
let retaking = false;
let problem = null;
const stored = readStored();
let pending = stored.prompts;
let structure = stored.structure;

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
  sync(session);
  render();
  listen();
}

/** Adopts the state the server just described, reloading the page under review if it moved on. */
function sync(state) {
  revision = state.revision;
  presence = state.presence;
  ended = state.ended;
  if (revision !== shownRevision) show();
}

function show() {
  if (editing) {
    // A half-typed note is worth more than three seconds of freshness; it lands when the card closes.
    deferredReload = true;
    return;
  }
  deferredReload = false;
  shownRevision = revision;
  frame.src = `${session.artifactUrl}?r=${revision}`;
}

/** Reads the stream until it ends, then reconnects; a few dead attempts in a row is a dead server. */
async function listen() {
  let failures = 0;
  while (failures < RETRIES) {
    stream = new AbortController();
    try {
      const res = await fetch(`/api/${key}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: stream.signal,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      failures = 0;
      connection = "live";
      render();
      for await (const line of lines(res.body)) apply(line);
    } catch {
      // A dropped stream and a taken-over one arrive the same way; the difference is intent.
    }
    if (retaking) {
      retaking = false;
      continue;
    }
    failures += 1;
    connection = "lost";
    render();
    await new Promise((resolve) => setTimeout(resolve, 500 * failures));
  }
  connection = "gone";
  render();
}

async function* lines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const part of parts) if (part !== "") yield JSON.parse(part);
  }
}

function apply(event) {
  if (event.type === "hello" || event.type === "current") {
    current = true;
    sync(event);
  } else if (event.type === "superseded") {
    current = false;
  } else if (event.type === "reload") {
    revision = event.revision;
    if (current) show();
  } else if (event.type === "presence") {
    presence = { state: event.state, since: event.since };
  } else if (event.type === "ended") {
    ended = { by: event.by };
    setAnnotate(false);
  } else if (event.type === "reopened") {
    ended = null;
  } else if (event.type === "reload-off") {
    liveReload = false;
  }
  render();
}

// The outline is stored beside the notes it was taken with: a chrome reload must not
// send a batch describing a page nobody outlined.
function readStored() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(pendingKey) ?? "{}");
    return {
      prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
      structure: typeof raw.structure === "string" ? raw.structure : "",
    };
  } catch {
    return { prompts: [], structure: "" };
  }
}

function savePending() {
  sessionStorage.setItem(pendingKey, JSON.stringify({ prompts: pending, structure }));
}

function render() {
  marks.replaceChildren(
    ...chat.map((entry) => mark(entry, true)),
    ...pending.map((entry) => mark(entry, false)),
  );
  marks.scrollTop = marks.scrollHeight;
  renderPresence();
  renderNotice();
  const working = presence.state === "working" && !ended;
  // Notes the agent's own end left behind stay sendable: they queue for its next check,
  // which is worth more than a tidy disabled button and a queue nobody can do anything with.
  const count = pending.length;
  sendButton.disabled = count === 0 || working;
  sendButton.textContent = working
    ? "Agent is working…"
    : count === 0
      ? ended
        ? "Review ended"
        : "Send to agent"
      : `Send ${count} ${count === 1 ? "note" : "notes"} ${ended ? "anyway" : "to agent"}`;
  annotateSwitch.disabled = ended !== null;
  endButton.disabled = ended !== null;
  // A failure the reviewer needs to see outlives the render that would otherwise write over it.
  statusLine.textContent = problem
    ? problem
    : ended
      ? count === 0
        ? "Nothing more can be sent from this page."
        : `${count} ${count === 1 ? "note was" : "notes were"} never sent. Send queues ${count === 1 ? "it" : "them"} for the agent's next check.`
      : working
        ? "Your agent is working on your last notes. Send opens again when it comes back."
        : deferredReload
          ? "The file changed. This page updates as soon as you finish this note."
          : chat.length === 0 && count === 0
            ? "Turn on Annotate, then click an element or Tab to it and press Enter. Select the text, or hold Shift and press an arrow key, for a passage."
            : count === 0
              ? "Every note has been sent."
              : `${count} not sent yet.`;
}

function renderPresence() {
  const [label, explanation] = PRESENCE[presence.state] ?? PRESENCE.waiting;
  presencePill.dataset.state = presence.state;
  presencePill.title = explanation;
  presenceText.textContent =
    presence.state === "working" ? `${label} ${elapsed(presence.since)}` : label;
  clearInterval(workingTimer);
  workingTimer = presence.state === "working" ? setInterval(renderPresence, 1000) : null;
}

function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line at the top of the margin for whatever has taken the page out of its normal state. */
function renderNotice() {
  const [text, action] = ended
    ? [ended.by === "user" ? "You ended this review." : "Your agent ended this review.", false]
    : !current
      ? ["Another tab took over this review, so this page has stopped updating.", true]
      : connection === "gone"
        ? ["Not connected. Run the command on this file again to get a fresh page.", false]
        : connection === "lost"
          ? ["Reconnecting…", false]
          : !liveReload
            ? ["Live reload stopped, so this page will not follow the file any more.", false]
            : [null, false];
  notice.hidden = text === null;
  noticeText.textContent = text ?? "";
  takeOverButton.hidden = !action;
}

function mark(entry, sent) {
  const li = document.createElement("li");
  li.className = sent ? "mark sent" : "mark";
  const target = document.createElement("div");
  target.className = "mark-target";
  const tag = document.createElement("span");
  tag.className = "mark-tag";
  tag.textContent = entry.tag;
  const text = document.createElement("span");
  text.className = "mark-text";
  text.textContent = describe(entry);
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

// Two notes on one element have to be told apart in the margin, so a passage is quoted
// and a cell carries the row and column it was named by.
function describe(entry) {
  if (entry.tag === "text") return `“${entry.text}”`;
  const cell = entry.target?.type === "table-cell" ? entry.target : null;
  const where = cell ? [cell.row, cell.column].filter(Boolean).join(" › ") : "";
  return where ? `${entry.text} · ${where}` : entry.text;
}

function post(message) {
  // The artifact has an opaque origin, so "*" is the only target that can name it.
  frame.contentWindow?.postMessage({ ...message, nonce }, "*");
}

function setAnnotate(on) {
  annotate = on;
  annotateSwitch.setAttribute("aria-checked", String(on));
  post({ type: "annotate", on });
}

window.addEventListener("message", (event) => {
  // Only the artifact frame's own window, which is always opaque-origin, is heard.
  if (event.source !== frame.contentWindow || event.origin !== "null") return;
  const data = event.data;
  if (data?.type === "ready") {
    nonce = crypto.randomUUID();
    post({ type: "init", annotate, scroll: lastScroll });
    document.body.dataset.ready = "1";
    return;
  }
  if (data?.nonce !== nonce) return;
  if (data.type === "annotate-ok") {
    document.body.dataset.annotate = data.on ? "1" : "0";
  } else if (data.type === "shown") {
    document.body.dataset.revision = String(shownRevision);
  } else if (data.type === "queue" && data.prompt && typeof data.prompt === "object") {
    pending.push(data.prompt);
    if (typeof data.structure === "string") structure = data.structure;
    savePending();
    render();
  } else if (data.type === "scroll") {
    lastScroll = { x: data.x, y: data.y };
  } else if (data.type === "editing") {
    editing = data.on;
    if (!editing && deferredReload) show();
    render();
  }
});

annotateSwitch.addEventListener("click", () => setAnnotate(!annotate));

takeOverButton.addEventListener("click", () => {
  retaking = true;
  stream?.abort();
});

endButton.addEventListener("click", () => {
  const count = pending.length;
  document.getElementById("endTitle").textContent = count
    ? `Send ${count} ${count === 1 ? "note" : "notes"} and end?`
    : "End this review?";
  document.getElementById("endText").textContent = count
    ? `${count === 1 ? "One note is" : `${count} notes are`} still waiting here. Ending sends ${count === 1 ? "it" : "them"} unless you discard ${count === 1 ? "it" : "them"}.`
    : "Your agent is told the review is over and stops waiting for notes.";
  endGo.textContent = count ? `Send and end` : "End review";
  endDiscard.hidden = count === 0;
  endDialog.showModal();
});

endDialog.addEventListener("close", async () => {
  const choice = endDialog.returnValue;
  if (choice !== "end" && choice !== "discard") return;
  const sending = choice === "end" ? pending : [];
  problem = null;
  try {
    await api("POST", `/api/${key}/end`, { by: "user", prompts: sending, structure });
    pending = [];
    savePending();
    chat = (await api("GET", `/api/${key}/session`)).chat;
    ended = { by: "user" };
    setAnnotate(false);
  } catch (error) {
    problem = `Could not end the review: ${error.message}`;
  }
  render();
});

document.getElementById("sendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending.length === 0) return;
  sendButton.disabled = true;
  sendButton.textContent = "Sending…";
  problem = null;
  try {
    await api("POST", `/api/${key}/prompts`, { prompts: pending, structure });
    pending = [];
    savePending();
    chat = (await api("GET", `/api/${key}/session`)).chat;
    render();
  } catch (error) {
    problem = `Could not send: ${error.message}`;
  }
  render();
});

boot();
