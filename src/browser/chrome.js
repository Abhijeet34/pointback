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
const card = /** @type {HTMLFormElement} */ (document.getElementById("card"));
const cardTarget = document.getElementById("cardTarget");
const cardText = /** @type {HTMLTextAreaElement} */ (document.getElementById("cardText"));
const cardCancel = /** @type {HTMLButtonElement} */ (document.getElementById("cardCancel"));
const presenceSince = document.getElementById("presenceSince");
const pendingKey = `pending:${key}`;

// Every label is read by a reviewer mid-review, so the resting state between two polls
// is "away", never a negative: it is the normal state, and Send works the same in it.
const PRESENCE = {
  waiting: [
    "Agent away",
    "Your agent is not checking for notes right now. Send still works: notes wait here and go out the next time it checks.",
  ],
  listening: ["Agent listening", "Your agent is connected and waiting for your notes."],
  working: ["Agent working", "Your agent took your last notes and is working on them."],
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
let marksDirty = true;
let shownMarks = 0;
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
  // The name and the session are independent, so both requests are in flight at once.
  const health = fetch("/health").then((r) => r.json());
  health.then((app) => (document.getElementById("appName").textContent = app.app));
  try {
    session = await api("GET", `/api/${key}/session`);
  } catch {
    statusLine.textContent =
      "This link no longer works. Run the command on the file again to get a fresh one.";
    return;
  }
  const app = await health;
  document.title = `${session.fileName} · ${app.app}`;
  document.getElementById("fileName").textContent = session.fileName;
  chat = session.chat;
  sync(session);
  render();
  listen();
  startHeartbeat(typeof app.idleMs === "number" ? app.idleMs : 1_800_000);
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

// The daemon idles out on inactivity, so a tab keeps it alive only while the reviewer is actually on
// it: a heartbeat runs while the tab is visible and stops while it is hidden. An open tab left and
// walked away from therefore stops holding the process, rather than pinning it open for good, and the
// review is not lost - pending notes live in sessionStorage and the tab resyncs when it comes back.
let heartbeat = null;
function beat() {
  fetch("/health").catch(() => {});
}
function startHeartbeat(idleMs) {
  clearInterval(heartbeat);
  const everyMs = Math.max(500, Math.floor(idleMs / 3));
  const tick = () => document.visibilityState === "visible" && beat();
  heartbeat = setInterval(tick, everyMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });
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
    closeCompose(false);
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

/** Every state change lands here; the notes list is rebuilt only when the notes changed. */
function render() {
  if (marksDirty) renderMarks();
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
  setText(
    statusLine,
    problem
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
              ? "Turn on Annotate, then click an element or select a passage and type a note. By keyboard: Tab to an element, Shift and an arrow key for a passage, Enter to note it."
              : count === 0
                ? "Every note has been sent."
                : `${count} ${count === 1 ? "note" : "notes"} ready to send.`,
  );
}

// Rebuilt only on a change to the notes, and scrolled to the end only when one was added:
// a presence flip or a reload must not yank a reviewer who scrolled up to reread a note.
function renderMarks() {
  marksDirty = false;
  marks.replaceChildren(
    ...chat.map((entry) => mark(entry, true)),
    ...pending.map((entry) => mark(entry, false)),
  );
  const shown = chat.length + pending.length;
  if (shown > shownMarks) marks.scrollTop = marks.scrollHeight;
  shownMarks = shown;
}

function notesChanged() {
  marksDirty = true;
  render();
}

/** A live region announces every write, so an unchanged status is left alone. */
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function renderPresence() {
  const [label, explanation] = PRESENCE[presence.state] ?? PRESENCE.waiting;
  presencePill.dataset.state = presence.state;
  presencePill.title = explanation;
  setText(presenceText, label);
  clearInterval(workingTimer);
  workingTimer = presence.state === "working" ? setInterval(tickSince, 1000) : null;
  tickSince();
}

// The clock ticks outside the live region, so a screen reader hears "working" once, not every second.
function tickSince() {
  presenceSince.textContent = presence.state === "working" ? elapsed(presence.since) : "";
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
            ? [
                "Live reload stopped, so this page no longer follows the file. Refresh to see the latest save.",
                false,
              ]
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
      notesChanged();
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
  if (!on) closeCompose(false);
  post({ type: "annotate", on });
}

// The note card is composed in the chrome, from a target the artifact proposed. The artifact
// sends the fields that describe what the reviewer pointed at, and never the note text, so a
// hostile page cannot put words in the reviewer's mouth. `composing` holds the pending note.
let composing = null;

function openCompose(note, label, outline, rects) {
  composing = { note, structure: typeof outline === "string" ? outline : "" };
  // A half-typed note is worth more than a live reload; the reload lands when the card closes.
  editing = true;
  cardTarget.textContent = label;
  cardText.value = "";
  card.hidden = false;
  placeCard(rects);
  cardText.focus();
  render();
}

function closeCompose(refocus) {
  if (card.hidden) return;
  card.hidden = true;
  composing = null;
  editing = false;
  if (deferredReload) show();
  // Tell the artifact the target is done so it drops the highlight; hand keyboard focus back to
  // the frame and, for the keyboard path, ask it to refocus the element the reviewer came from.
  post({ type: "compose", on: false, refocus });
  if (refocus) frame.focus();
  render();
}

/** Places the card over the artifact at the spot the reviewer pointed at, clamped to the mount. */
function placeCard(rects) {
  const mount = frame.parentElement;
  const bounds = mount.getBoundingClientRect();
  const frameBox = frame.getBoundingClientRect();
  const r = Array.isArray(rects) && rects.length ? rects[rects.length - 1] : { left: 0, bottom: 0 };
  const originX = frameBox.left - bounds.left;
  const originY = frameBox.top - bounds.top;
  const top = Math.min(originY + r.bottom + 8, bounds.height - card.offsetHeight - 8);
  const left = Math.min(originX + r.left, bounds.width - card.offsetWidth - 8);
  card.style.top = `${Math.max(8, top)}px`;
  card.style.left = `${Math.max(8, left)}px`;
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
  } else if (data.type === "target" && data.note && typeof data.note === "object") {
    // The artifact proposes a target; the reviewer's instruction is composed in the chrome, never
    // sent by the page. A `queue` message carrying note text is deliberately not accepted here.
    openCompose(
      data.note,
      typeof data.label === "string" ? data.label : "",
      data.structure,
      data.rects,
    );
  } else if (data.type === "scroll") {
    lastScroll = { x: data.x, y: data.y, selector: data.selector, text: data.text, top: data.top };
    // Published for the same reason as ready, revision and annotate: the reviewer's place is
    // what a reload restores, and it arrives from another frame's event loop. Anything acting
    // on it - a reload, a test - would otherwise be guessing that the report had landed.
    document.body.dataset.scroll = String(data.y);
    // The element the place is anchored to, published for the same reason: a container spanning
    // the document restores the offset the anchor exists to replace, and only naming it here
    // lets a test say so rather than infer it from where the page happened to land.
    document.body.dataset.place = data.selector ?? "";
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
  notesChanged();
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
  } catch (error) {
    problem = `Could not send: ${error.message}`;
  }
  notesChanged();
});

card.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = cardText.value.trim();
  if (!composing || prompt === "") return;
  // The instruction is this textarea's value; every other field describes the target the artifact
  // proposed. This is the only path that adds a note, and it runs only on the reviewer's submit.
  // Stamped here, after the target spread, so the moment the reviewer wrote it survives a send
  // that batches ten minutes of notes into one instant, and no proposed `at` can displace it.
  pending.push({ prompt, ...composing.note, at: new Date().toISOString() });
  structure = composing.structure;
  savePending();
  // The one path that adds a note, so the one that must mark the list stale: closeCompose's own
  // render leaves it alone, which is the point - a presence flip or a reload must not rebuild it.
  marksDirty = true;
  closeCompose(true);
});
cardText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    card.requestSubmit();
  } else if (event.key === "Escape") {
    closeCompose(true);
  }
});
cardCancel.addEventListener("click", () => closeCompose(true));

boot();
