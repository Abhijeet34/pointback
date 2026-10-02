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

// Every label is read by a reviewer mid-review, so the resting state between two polls
// is "away", never a negative: it is the normal state, and Send works the same in it.
const PRESENCE = {
  waiting: [
    "Agent away",
    "Your agent is not checking for notes right now. Send still works: notes wait here and go out the next time it checks.",
  ],
  listening: ["Agent listening", "Your agent is connected and waiting for your notes."],
  working: [
    "Agent working",
    "Your agent took your last notes and is working on them. New notes queue for its next check.",
  ],
  offline: [
    "Not connected",
    "This page lost its connection. Your notes are kept and nothing can be sent until it is back.",
  ],
};

let nonce = "";
let annotate = false;
let chat = [];
let session = null;
let revision = 0;
let shownRevision = -1;
let shownUrl = "";
let presence = { state: "waiting" };
let ended = null;
let fileGone = false;
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
let appName = "";
// The reviewer's unsent notes, as the server holds them: every change goes through it first.
let pending = [];

const api = (method, path, body) => {
  // The token goes only to the server this page proved holds it; a lost connection may mean the
  // port now belongs to something else.
  if (connection !== "live") return Promise.reject(new Error("not connected"));
  return fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `${res.status}`);
    return json;
  });
};

/**
 * What answers on this page's port, with `proven` saying whether it holds this page's token; a throw
 * when nothing answers. It proves it by keying a fresh challenge with the token, which never leaves.
 */
async function health() {
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const challenge = hex(crypto.getRandomValues(new Uint8Array(16)));
  const res = await fetch(`/health?challenge=${challenge}`);
  const answer = await res.json().catch(() => ({}));
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const proof = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(challenge));
  return { ...answer, proven: res.ok && answer.proof === hex(new Uint8Array(proof)) };
}

const pause = (failures) =>
  new Promise((resolve) => setTimeout(resolve, Math.min(500 * failures, 5000)));

async function boot() {
  let app;
  for (let failures = 1; !app; failures += 1) {
    try {
      app = await health();
    } catch {
      // Nothing answers: a daemon between an idle-out and the agent's next command. The review is
      // still there, so the page waits for it rather than calling its link dead.
      setText(
        statusLine,
        "Not connected. This page opens the review when your agent next runs its command.",
      );
      await pause(failures);
    }
  }
  try {
    if (!app.proven) throw new Error("unproven");
    session = await api("GET", `/api/${key}/session`);
  } catch {
    statusLine.textContent =
      "This link no longer works. Run the command on the file again to get a fresh one.";
    return;
  }
  appName = app.app;
  document.getElementById("appName").textContent = appName;
  document.title = `${session.fileName} · ${app.app}`;
  document.getElementById("fileName").textContent = session.fileName;
  sync(session);
  render();
  listen();
  startHeartbeat(typeof app.idleMs === "number" ? app.idleMs : 1_800_000);
}

/** Adopts the state the server just described, reloading the page under review if it moved on. */
function sync(state) {
  revision = state.revision;
  // A later open with another --root moves the page's own address, so a tab promoted back follows it.
  session.artifactUrl = state.artifactUrl;
  presence = state.presence;
  ended = state.ended;
  // The sent notes come with every hello, so a reply that landed while this page was away shows.
  chat = state.chat;
  pending = state.drafts;
  marksDirty = true;
  // A gone file has no page to load; the last one shown stays up under the notice.
  fileGone = state.gone === true;
  if (fileGone) setAnnotate(false);
  else if (revision !== shownRevision || session.artifactUrl !== shownUrl) show();
}

function show() {
  if (editing) {
    // A half-typed note is worth more than three seconds of freshness; it lands when the card closes.
    deferredReload = true;
    return;
  }
  deferredReload = false;
  shownRevision = revision;
  shownUrl = session.artifactUrl;
  frame.src = `${shownUrl}?r=${revision}`;
}

/**
 * Reads the stream until it ends, then reconnects for as long as nothing answers: a daemon that
 * idled out or was stopped comes back on the same port with the same token at the agent's next
 * command, and this page picks the review up again. Something that answers and cannot prove it
 * holds the token, or refuses it, means this page's link is spent, and it stops trying.
 */
async function listen() {
  let failures = 0;
  for (;;) {
    stream = new AbortController();
    let spent = false;
    try {
      spent = !(await health()).proven;
      if (spent) break;
      const res = await fetch(`/api/${key}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: stream.signal,
      });
      spent = !res.ok;
      if (spent) break;
      failures = 0;
      connection = "live";
      render();
      for await (const line of lines(res.body)) apply(line);
    } catch {
      // A dropped stream and a taken-over one arrive the same way; the difference is intent.
    }
    if (spent) break;
    if (retaking) {
      retaking = false;
      continue;
    }
    failures += 1;
    connection = "lost";
    render();
    await pause(failures);
  }
  connection = "gone";
  render();
}

// The daemon idles out on inactivity, so a tab keeps it alive only while the reviewer is actually on
// it: a heartbeat runs while the tab is visible and stops while it is hidden. An open tab left and
// walked away from therefore stops holding the process, rather than pinning it open for good, and the
// review is not lost - unsent notes live on the server and the tab resyncs when it comes back.
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
    // A reload means the file is there to read, including one that came back after it was gone.
    fileGone = false;
    revision = event.revision;
    if (current) show();
  } else if (event.type === "gone") {
    fileGone = true;
    setAnnotate(false);
  } else if (event.type === "presence") {
    presence = { state: event.state, since: event.since };
  } else if (event.type === "ended") {
    ended = { by: event.by };
    marksDirty = true;
    setAnnotate(false);
  } else if (event.type === "reopened") {
    ended = null;
    marksDirty = true;
  } else if (event.type === "reload-off") {
    liveReload = false;
  } else if (event.type === "drafts") {
    pending = event.drafts;
    marksDirty = true;
  } else if (event.type === "reply") {
    const note = chat.find((entry) => entry.uid === event.uid);
    if (note) note.reply = event.reply;
    marksDirty = true;
  }
  render();
}

/** Adopts the server's answer to a change of the unsent notes, or says why it was refused. */
async function changeDrafts(what, method, path, body) {
  problem = null;
  try {
    pending = (await api(method, path, body)).drafts;
    return true;
  } catch (error) {
    problem = `Could not ${what}: ${error.message}`;
    return false;
  } finally {
    notesChanged();
  }
}

/** Every state change lands here; the notes list is rebuilt only when the notes changed. */
function render() {
  if (marksDirty) renderMarks();
  renderPresence();
  renderNotice();
  const working = presence.state === "working" && !ended;
  const offline = connection !== "live";
  // Notes the agent's own end left behind stay sendable: they queue for its next check,
  // which is worth more than a tidy disabled button and a queue nobody can do anything with.
  // So do notes written while the agent works: the server queues them behind its batch.
  const count = pending.length;
  const asking = chat.some((entry) => unanswered(entry));
  const replied = chat.length > 0 && chat.every((entry) => entry.reply);
  sendButton.disabled = count === 0 || fileGone || offline;
  sendButton.textContent = fileGone
    ? "File is gone"
    : offline
      ? "Not connected"
      : count === 0
        ? ended
          ? "Review ended"
          : "Send to agent"
        : `Send ${count} ${count === 1 ? "note" : "notes"} ${ended ? "anyway" : "to agent"}`;
  annotateSwitch.disabled = ended !== null || fileGone;
  endButton.disabled = ended !== null || fileGone;
  // A failure the reviewer needs to see outlives the render that would otherwise write over it.
  setText(
    statusLine,
    problem
      ? problem
      : fileGone
        ? count === 0
          ? "Nothing can be sent while the file is gone."
          : `${count} ${count === 1 ? "note stays" : "notes stay"} here, and Send opens again if the file comes back.`
        : ended
          ? count === 0
            ? "Nothing more can be sent from this page."
            : `${count} ${count === 1 ? "note was" : "notes were"} never sent. Send queues ${count === 1 ? "it" : "them"} for the agent's next check.`
          : offline
            ? count === 0
              ? "Nothing can be sent until this page reconnects."
              : `${count} ${count === 1 ? "note is" : "notes are"} kept, and Send opens again when this page reconnects.`
            : deferredReload
              ? "The file changed. This page updates as soon as you finish this note."
              : asking
                ? "Your agent asked you a question. Answer it on its note, then send."
                : working && count === 0
                  ? "Your agent is working on your last notes. Anything you send now waits for its next check."
                  : chat.length === 0 && count === 0
                    ? "Turn on Annotate, then click an element or select a passage and type a note. By keyboard: Tab to an element, Shift and an arrow key for a passage, Enter to note it."
                    : count === 0
                      ? replied
                        ? "Your agent has answered every note."
                        : "Every note has been sent."
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
  // What the server last said about the agent is stale the moment the connection goes.
  const state = connection === "live" ? presence.state : "offline";
  const [label, explanation] = PRESENCE[state] ?? PRESENCE.waiting;
  presencePill.dataset.state = state;
  presencePill.title = explanation;
  setText(presenceText, label);
  clearInterval(workingTimer);
  workingTimer = state === "working" ? setInterval(tickSince, 1000) : null;
  tickSince();
}

// The clock ticks outside the live region, so a screen reader hears "working" once, not every second.
function tickSince() {
  presenceSince.textContent =
    presencePill.dataset.state === "working" ? elapsed(presence.since) : "";
}

function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line at the top of the margin for whatever has taken the page out of its normal state. */
function renderNotice() {
  const [text, action] = fileGone
    ? ["The file was moved or deleted, so this review cannot go on.", false]
    : ended
      ? [ended.by === "user" ? "You ended this review." : "Your agent ended this review.", false]
      : !current
        ? ["Another tab took over this review, so this page has stopped updating.", true]
        : connection === "gone"
          ? [
              `This page can no longer reach its review. Run ${appName} on this file again for a fresh page; your notes are kept there.`,
              false,
            ]
          : connection === "lost"
            ? [
                `Not connected. Your notes are kept, and this page reconnects when your agent next runs ${appName}.`,
                false,
              ]
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
  tag.textContent = entry.answers === undefined ? entry.tag : "answer";
  const text = document.createElement("span");
  text.className = "mark-text";
  text.textContent = describe(entry);
  target.append(tag, text);
  const note = document.createElement("p");
  note.className = "mark-note";
  note.textContent = entry.prompt;
  li.append(target, note);
  if (entry.reply) li.append(replyLine(entry));
  if (!sent) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mark-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove this note");
    remove.addEventListener("click", () =>
      changeDrafts("remove the note", "DELETE", `/api/${key}/drafts/${entry.id}`),
    );
    li.append(remove);
  }
  return li;
}

const REPLY_LABELS = { done: "Done", declined: "Declined", question: "Question" };

/** The agent's answer, set as text: the agent wrote it, so markup in it shows as typed. */
function replyLine(entry) {
  const line = document.createElement("p");
  line.className = "mark-reply";
  line.dataset.status = entry.reply.status;
  const label = document.createElement("span");
  label.className = "mark-reply-label";
  label.textContent = REPLY_LABELS[entry.reply.status] ?? entry.reply.status;
  line.append(label);
  if (entry.reply.message) line.append(` ${entry.reply.message}`);
  if (unanswered(entry)) {
    const answer = document.createElement("button");
    answer.type = "button";
    answer.className = "quiet mark-answer";
    answer.textContent = "Answer";
    answer.addEventListener("click", () => {
      if (composing) return cardText.focus();
      const box = line.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      const { selector, tag, text, target } = entry;
      // The answer points where the question's note did, and names the note it answers.
      openCompose(
        { selector, tag, text, target, answers: entry.uid },
        `Answer: ${entry.reply.message}`,
        undefined,
        [{ left: Infinity, bottom: box.top - frameBox.top }],
        answer,
      );
    });
    line.append(answer);
  }
  return line;
}

/** A question still waiting on the reviewer: no answer to it is sent or waiting to be. */
function unanswered(entry) {
  return (
    entry.reply?.status === "question" &&
    !ended &&
    !chat.some((other) => other.answers === entry.uid) &&
    !pending.some((other) => other.answers === entry.uid)
  );
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

function openCompose(note, label, outline, rects, from) {
  composing = { note, structure: typeof outline === "string" ? outline : undefined, from };
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
  const from = composing?.from;
  composing = null;
  editing = false;
  if (deferredReload) show();
  // Tell the artifact the target is done so it drops the highlight; hand keyboard focus back to
  // the frame and, for the keyboard path, ask it to refocus the element the reviewer came from.
  // An answer came from the margin, so focus goes back there, or on to Send once it is added.
  post({ type: "compose", on: false, refocus: refocus && !from });
  if (refocus) (from ? (from.isConnected ? from : sendButton) : frame).focus();
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
    // A proposal is heard only while the reviewer has Annotate on and no card open: the page can
    // send one at any moment, and must not pop the card, take focus, or wipe a note being typed.
    if (!annotate || composing) return;
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
  problem = null;
  try {
    await api("POST", `/api/${key}/end`, {
      by: "user",
      drafts: choice === "end" ? "send" : "discard",
    });
    ({ chat, drafts: pending } = await api("GET", `/api/${key}/session`));
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
    await api("POST", `/api/${key}/prompts`);
    ({ chat, drafts: pending } = await api("GET", `/api/${key}/session`));
  } catch (error) {
    problem = `Could not send: ${error.message}`;
  }
  notesChanged();
});

let adding = false;
card.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = cardText.value.trim();
  if (!composing || prompt === "" || adding) return;
  // The instruction is this textarea's value; the other fields are copied by name from the target
  // the artifact proposed, so nothing else it sent rides along and nothing it sent can displace
  // `prompt`. This is the only path that adds a note, and it runs only on the reviewer's submit;
  // the server stamps it, so the moment the reviewer wrote it survives a batched send.
  const { selector, tag, text, target, answers } = composing.note;
  adding = true;
  const kept = await changeDrafts("add the note", "POST", `/api/${key}/drafts`, {
    draft: { selector, tag, text, target, answers, prompt },
    structure: composing.structure,
  });
  adding = false;
  // A note the server did not take stays in the card, still typed, beside the reason.
  if (kept) closeCompose(true);
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
