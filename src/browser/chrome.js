// The chrome page: bootstraps the session, hosts the sandboxed artifact, keeps the notes margin,
// and stays on the server's event stream so the page, the agent's presence and the end of the
// review are never something the reviewer has to discover by trying an action that no longer works.
const key = location.pathname.split("/").pop();
const token = location.hash.slice(1);
const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const marks = document.getElementById("marks");
const marginBody = document.getElementById("marginBody");
const statusLine = document.getElementById("status");
const notice = document.getElementById("notice");
const noticeText = document.getElementById("noticeText");
const takeOverButton = /** @type {HTMLButtonElement} */ (document.getElementById("takeOver"));
const cover = document.getElementById("cover");
const coverText = document.getElementById("coverText");
const backButton = /** @type {HTMLButtonElement} */ (document.getElementById("back"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const annotateSwitch = /** @type {HTMLInputElement} */ (document.getElementById("annotate"));
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
// Annotate starts on: pointing is what this page is for, and a target the page proposes is still
// heard only after the reviewer's own gesture in it (`gesture` below), never on its own. `annotate`
// is what is in force; `wantAnnotate` is the reviewer's choice, which comes back when a gone file
// returns or an ended review is reopened.
let annotate = true;
let wantAnnotate = true;
let chat = [];
let session = null;
let revision = 0;
let shownRevision = -1;
let shownUrl = "";
let presence = { state: "waiting" };
let ended = null;
let fileGone = false;
// The frame's page announced itself as the one under review; one that loads without doing so is a
// link the reviewer followed or a missing page the server answered for, and the frame has strayed.
let announced = false;
let strayed = false;
let current = true;
let liveReload = true;
let connection = "live";
let editing = false;
let deferredReload = false;
// A send is in flight: Send stays shut until the server's answer has replaced the unsent notes.
let sending = false;
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
// The note last shown from the margin or its pin, by number; the draft being edited in place;
// and the notes whose pin found nothing on the page to stand on.
let shownNote = 0;
let editingNote = null;
let missingPins = new Set();
const SEND_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Enter" : "Ctrl+Enter";

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
      // still there, so the page waits for it rather than calling its link dead, and the bar and
      // Send say it is not connected rather than offering what cannot work yet.
      connection = "lost";
      renderPresence();
      setText(sendButton, "Not connected");
      setText(
        statusLine,
        "Not connected. This page opens the review when your agent next runs its command.",
      );
      await pause(failures);
    }
  }
  connection = "live";
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
  followAnnotate();
  if (!fileGone && (revision !== shownRevision || session.artifactUrl !== shownUrl)) show();
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
    followAnnotate();
    revision = event.revision;
    if (current) show();
  } else if (event.type === "rerooted") {
    session.artifactUrl = event.artifactUrl;
    if (current) show();
  } else if (event.type === "gone") {
    fileGone = true;
    followAnnotate();
  } else if (event.type === "presence") {
    presence = { state: event.state, since: event.since };
  } else if (event.type === "ended") {
    ended = { by: event.by };
    marksDirty = true;
    followAnnotate();
  } else if (event.type === "reopened") {
    ended = null;
    marksDirty = true;
    followAnnotate();
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
  // A question waits on the reviewer, so its Answer is brought into view, with the question
  // above it; any other reply stays put.
  if (event.type === "reply" && event.reply.status === "question")
    marks
      .querySelector(`[data-uid="${event.uid}"] .mark-answer`)
      ?.scrollIntoView({ block: "nearest" });
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
  renderCover();
  const working = presence.state === "working" && !ended;
  const offline = connection !== "live";
  // Notes the agent's own end left behind stay sendable: they queue for its next check,
  // which is worth more than a tidy disabled button and a queue nobody can do anything with.
  // So do notes written while the agent works: the server queues them behind its batch.
  const count = pending.length;
  const asking = chat.some((entry) => unanswered(entry));
  const replied = chat.length > 0 && chat.every((entry) => entry.reply);
  // An event landing mid-send renders before this tab has the server's answer, with the notes
  // still listed as unsent; Send must not offer them again in that gap.
  sendButton.disabled = sending || count === 0 || fileGone || offline;
  sendButton.textContent = sending
    ? "Sending…"
    : fileGone
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
            : strayed && count === 0
              ? "Go back to the page under review to point at it again."
              : deferredReload
                ? "The file changed. This page updates as soon as you finish this note."
                : asking
                  ? "Your agent asked you a question. Answer it on its note, then send."
                  : replied && count === 0
                    ? "Your agent has answered every note."
                    : working && count === 0
                      ? "Your agent is working on your last notes. Anything you send now waits for its next check."
                      : chat.length === 0 && count === 0
                        ? annotate
                          ? `Click or select anything on the page to note it, or Tab to it and press Enter. H jumps to the next heading, A turns Annotate off, ${SEND_KEY} sends.`
                          : "Turn on Annotate, or press A, to point at the page."
                        : count === 0
                          ? "Every note has been sent."
                          : `${count} ${count === 1 ? "note" : "notes"} ready to send. ${SEND_KEY} sends.`,
  );
}

// Rebuilt only on a change to the notes, and scrolled to the end only when one was added:
// a presence flip or a reload must not yank a reviewer who scrolled up to reread a note.
function renderMarks() {
  marksDirty = false;
  // A rebuild must not take the words, the caret or the focus out of a note being edited.
  const box = /** @type {HTMLTextAreaElement | null} */ (marks.querySelector(".mark-edit-text"));
  const caret = box && document.activeElement === box && [box.selectionStart, box.selectionEnd];
  if (editingNote && !pending.some((entry) => entry.id === editingNote.id)) {
    problem = "That note was sent or removed in another tab before your edit was saved.";
    editingNote = null;
  }
  const notes = allNotes();
  marks.replaceChildren(...notes.map(({ entry, sent }, index) => mark(entry, sent, index + 1)));
  if (shownNote > notes.length) shownNote = 0;
  const shown = notes.length;
  if (shown > shownMarks) marginBody.scrollTop = marginBody.scrollHeight;
  shownMarks = shown;
  const editor = /** @type {HTMLTextAreaElement | null} */ (marks.querySelector(".mark-edit-text"));
  if (editor && caret) {
    editor.focus();
    editor.setSelectionRange(caret[0], caret[1]);
  }
  post({ type: "pins", pins: pinData() });
}

/** Every note in the margin's order, which is the order the pins are numbered in. */
function allNotes() {
  return [
    ...chat.map((entry) => ({ entry, sent: true })),
    ...pending.map((entry) => ({ entry, sent: false })),
  ];
}

const noteState = (entry, sent) => (sent ? (entry.reply?.status ?? "sent") : "queued");

/**
 * What the artifact needs to draw a pin: a number, a state, and the anchor the page itself proposed.
 * Never the instruction or the agent's reply: the page under review reads every message it is sent.
 */
function pinData() {
  return allNotes().map(({ entry, sent }, index) => ({
    n: index + 1,
    state: noteState(entry, sent),
    selector: entry.selector,
    tag: entry.tag,
    text: entry.text,
    ...(entry.target && { target: entry.target }),
  }));
}

/** A margin note's way back to the page: its pin is highlighted and its target scrolled into view. */
function revealNote(n) {
  shownNote = n;
  markShown();
  post({ type: "reveal", n });
}

/** A pin's way back to the margin: its note is brought into view and takes the focus. */
function focusNote(n) {
  const li = marks.children[n - 1];
  if (!li) return;
  shownNote = n;
  markShown();
  li.scrollIntoView({ block: "nearest" });
  /** @type {HTMLElement} */ (li.querySelector(".mark-target")).focus({ preventScroll: true });
}

function markShown() {
  [...marks.children].forEach((li, index) => li.classList.toggle("shown", index + 1 === shownNote));
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

/** A frame that strayed is covered where the reviewer is looking, with the way back on top. */
function renderCover() {
  cover.hidden = !strayed;
  if (!strayed) return;
  setText(
    coverText,
    `The frame went to a page that is missing or is not ${session.fileName}, so nothing on it can be noted.`,
  );
  setText(backButton, `Back to ${session.fileName}`);
}

function mark(entry, sent, n) {
  const li = document.createElement("li");
  li.className = sent ? "hw-note mark sent" : "hw-note mark";
  // Only a queued note has an id, so only a queued note can be the one being edited.
  const edited = !sent && editingNote !== null && editingNote.id === entry.id;
  li.classList.toggle("shown", n === shownNote);
  li.classList.toggle("editing", edited);
  li.dataset.state = noteState(entry, sent);
  if (sent) li.dataset.uid = String(entry.uid);
  else li.dataset.id = entry.id;
  // The number and what the note points at are one button: pressing it shows the place on the page.
  const target = document.createElement("button");
  target.type = "button";
  target.className = "mark-target";
  const number = document.createElement("span");
  number.className = "hw-pin mark-number";
  number.textContent = String(n);
  const locator = document.createElement("span");
  locator.className = "hw-note-locator mark-locator";
  const tag = document.createElement("span");
  tag.className = "mark-tag";
  const text = document.createElement("span");
  text.className = "mark-text";
  // The reviewer reads what was pointed at in words; the tag itself is the agent's, in the note.
  const answered = allNotes().findIndex(({ entry: other }) => other.uid === entry.answers) + 1;
  tag.textContent = entry.answers === undefined ? kindOf(entry) : "Answer";
  text.textContent = entry.answers === undefined ? describe(entry) : `to note ${answered}`;
  locator.append(tag, text.textContent ? " · " : "", text);
  locator.title = locator.textContent;
  target.append(number, locator);
  target.setAttribute("aria-label", `Note ${n}, on ${locator.textContent}. Show it on the page`);
  target.addEventListener("click", () => revealNote(n));
  const head = document.createElement("div");
  head.className = "mark-head";
  head.append(target);
  li.append(head);
  if (missingPins.has(n)) li.append(missingLine());
  li.append(edited ? editor(entry, n) : noteText(entry));
  if (entry.reply) li.append(replyLine(entry));
  if (!sent && !edited) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "hw-btn hw-btn--quiet hw-btn--sm mark-edit";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit note ${n}`);
    edit.addEventListener("click", async () => {
      // Moving to another note keeps what was typed in the last one rather than dropping it.
      if (!(await saveEdit())) return;
      editingNote = { id: entry.id, value: entry.prompt };
      notesChanged();
      const box = /** @type {HTMLTextAreaElement} */ (marks.querySelector(".mark-edit-text"));
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "hw-btn hw-btn--quiet hw-btn--sm hw-btn--icon mark-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove note ${n}`);
    remove.addEventListener("click", () =>
      changeDrafts("remove the note", "DELETE", `/api/${key}/drafts/${entry.id}`),
    );
    head.append(edit, remove);
  }
  return li;
}

function noteText(entry) {
  const note = document.createElement("p");
  note.className = "mark-note";
  note.textContent = entry.prompt;
  return note;
}

function showMissing() {
  [...marks.children].forEach((li, index) => {
    const line = li.querySelector(".mark-missing");
    const missing = missingPins.has(index + 1);
    if (missing && !line) li.querySelector(".mark-head").after(missingLine());
    else if (!missing && line) line.remove();
  });
}

function missingLine() {
  const line = document.createElement("p");
  line.className = "mark-missing";
  line.textContent = "No longer on the page";
  return line;
}

/** A queued note edited where it stands: Enter saves, Shift+Enter breaks the line, Escape keeps it. */
function editor(entry, n) {
  const form = document.createElement("form");
  form.className = "mark-editor";
  const box = document.createElement("textarea");
  box.className = "hw-textarea mark-edit-text";
  box.value = editingNote.value;
  box.rows = 3;
  box.setAttribute("aria-label", `Note ${n}`);
  box.addEventListener("input", () => {
    editingNote.value = box.value;
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      // Send saves the note being edited first, so this is save and send in one.
      event.preventDefault();
      sendNow();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      stopEditing();
    }
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "hw-btn hw-btn--quiet hw-btn--sm";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", stopEditing);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "hw-btn hw-btn--accent hw-btn--sm";
  save.textContent = "Save";
  const row = document.createElement("div");
  row.className = "card-row";
  row.append(cancel, save);
  form.append(box, row);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveEdit();
  });
  return form;
}

/** Saves the note being edited, if any; true when nothing is left unsaved. */
async function saveEdit() {
  if (!editingNote) return true;
  const { id, value } = editingNote;
  const prompt = value.trim();
  if (prompt === "") {
    problem = "A note cannot be empty. Remove it with × instead.";
    render();
    return false;
  }
  const saved = await changeDrafts("save the note", "PATCH", `/api/${key}/drafts/${id}`, {
    prompt,
  });
  if (saved) stopEditing();
  return saved;
}

function stopEditing() {
  const id = editingNote?.id;
  editingNote = null;
  notesChanged();
  /** @type {HTMLElement | null} */ (marks.querySelector(`[data-id="${id}"] .mark-edit`))?.focus();
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
    answer.className = "hw-btn hw-btn--sm mark-answer";
    answer.textContent = "Answer";
    answer.addEventListener("click", () => {
      if (composing) return cardText.focus();
      const box = line.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      const { selector, lines, tag, text, target } = entry;
      // The answer points where the question's note did, and names the note it answers.
      openCompose(
        { selector, lines, tag, text, target, answers: entry.uid },
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

// What the reviewer pointed at, in their words rather than the page's markup.
const KINDS = Object.assign(Object.create(null), {
  text: "Passage",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  p: "Paragraph",
  td: "Cell",
  th: "Cell",
  tr: "Row",
  table: "Table",
  caption: "Caption",
  ul: "List",
  ol: "List",
  dl: "List",
  li: "List item",
  dt: "List item",
  dd: "List item",
  img: "Picture",
  picture: "Picture",
  svg: "Graphic",
  canvas: "Graphic",
  video: "Video",
  figure: "Figure",
  figcaption: "Caption",
  blockquote: "Quote",
  pre: "Code",
  code: "Code",
  a: "Link",
  button: "Button",
  input: "Field",
  textarea: "Field",
  select: "Choice",
  label: "Label",
  summary: "Summary",
  details: "Details",
  mark: "Highlight",
  nav: "Navigation",
  header: "Header",
  footer: "Footer",
  form: "Form",
  dialog: "Dialog",
});

const kindOf = (note) => KINDS[note.tag] ?? "Element";

// Two notes on one element have to be told apart in the margin, so a passage is quoted and a
// cell leads with the row and column it was named by, which a one-line locator must not cut.
function describe(entry) {
  if (entry.tag === "text") return `“${entry.text}”`;
  const cell = entry.target?.type === "table-cell" ? entry.target : null;
  const where = cell ? [cell.row, cell.column].filter(Boolean).join(" › ") : "";
  // A control or a picture is told apart by its name, then its text, alt or source.
  const text = entry.target?.name || entry.text || entry.target?.alt || entry.target?.src || "";
  return [where, text].filter(Boolean).join(" · ");
}

/** The card's one line: built here from the target's fields, never from words the page supplied. */
const locatorOf = (note) => [kindOf(note), describe(note)].filter(Boolean).join(" · ");

function post(message) {
  // The artifact has an opaque origin, so "*" is the only target that can name it.
  frame.contentWindow?.postMessage({ ...message, nonce }, "*");
}

function setAnnotate(on) {
  annotate = on;
  annotateSwitch.checked = on;
  if (!on) closeCompose(false);
  post({ type: "annotate", on });
  render();
}

/** Puts Annotate where the reviewer left it, unless a gone file or an ended review rules it out. */
function followAnnotate() {
  const on = wantAnnotate && !fileGone && ended === null;
  if (on !== annotate) setAnnotate(on);
}

// A page under review can post at any moment. What it proposes is acted on only straight after the
// reviewer's own click or key inside it, so it can neither pop the card nor move focus by itself.
const gesture = () =>
  navigator.userActivation?.isActive === true && document.activeElement === frame;

// The note card is composed in the chrome, from a target the artifact proposed. The artifact
// sends the fields that describe what the reviewer pointed at, and never the note text, so a
// hostile page cannot put words in the reviewer's mouth. `composing` holds the pending note.
let composing = null;

function openCompose(note, label, outline, rects, from) {
  composing = { note, structure: typeof outline === "string" ? outline : undefined, from };
  // A half-typed note is worth more than a live reload; the reload lands when the card closes.
  editing = true;
  cardTarget.textContent = label;
  cardTarget.title = label;
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
  // The page's own coordinates start inside the frame's border.
  const frameBox = frame.getBoundingClientRect();
  const r = Array.isArray(rects) && rects.length ? rects[rects.length - 1] : { left: 0, bottom: 0 };
  const originX = frameBox.left + frame.clientLeft - bounds.left;
  const originY = frameBox.top + frame.clientTop - bounds.top;
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
    post({ type: "init", annotate, scroll: lastScroll, pins: pinData() });
    document.body.dataset.ready = "1";
    announced = true;
    if (strayed) {
      // Back is about to be hidden under the reviewer, so the focus goes where Back led.
      if (document.activeElement === backButton) frame.focus();
      strayed = false;
      render();
    }
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
    // A proposal is heard only while the reviewer has Annotate on, no card open, and has just
    // clicked or pressed a key in the page: the page can send one at any moment, and must not pop
    // the card, take focus, or wipe a note being typed.
    if (!annotate || composing || !gesture()) return;
    // Only what the reviewer pointed at: `answers` is the chrome's to set, from the margin.
    const { selector, lines, tag, text, target } = data.note;
    const note = { selector, lines, tag, text, target };
    openCompose(note, locatorOf(note), data.structure, data.rects);
  } else if (data.type === "key") {
    // The review's keys pressed in the page. Like a target, a key is heard only under the
    // reviewer's own press in the frame; the controls it reaches are the ones the bar offers.
    if (!gesture()) return;
    if (data.action === "annotate") annotateSwitch.click();
    else if (data.action === "send") sendNow();
  } else if (data.type === "pin" && Number.isInteger(data.n)) {
    // Only the number crosses back; the note it names is the chrome's own, and focusing it is all
    // a pin can do, and only under the reviewer's own press.
    if (gesture()) focusNote(data.n);
  } else if (data.type === "placed" && Array.isArray(data.missing)) {
    // Toggled in place, never by a rebuild: the page can send this as often as it likes, and must
    // not be able to take the focus or a half-typed edit out of the margin by doing so.
    missingPins = new Set(data.missing.filter(Number.isInteger));
    showMissing();
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

annotateSwitch.addEventListener("click", () => {
  wantAnnotate = !annotate;
  setAnnotate(wantAnnotate);
});

frame.addEventListener("load", () => {
  if (!shownUrl) return;
  strayed = !announced;
  announced = false;
  render();
  // The page the focus was in is covered now; Back is the one thing left to press there.
  if (strayed && document.activeElement === frame) backButton.focus();
});

backButton.addEventListener("click", show);

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
  // Discarding drops the note being edited along with the rest; nothing is left to save.
  if (choice === "discard") editingNote = null;
  // What the reviewer last typed is what goes, even if they ended mid-edit.
  if (choice === "end" && !(await saveEdit())) return;
  problem = null;
  try {
    await api("POST", `/api/${key}/end`, {
      by: "user",
      drafts: choice === "end" ? "send" : "discard",
    });
    ({ chat, drafts: pending } = await api("GET", `/api/${key}/session`));
    ended = { by: "user" };
    followAnnotate();
  } catch (error) {
    problem = `Could not end the review: ${error.message}`;
  }
  notesChanged();
});

const sendForm = /** @type {HTMLFormElement} */ (document.getElementById("sendForm"));

/** The send key: adds the note being written, if any, then sends whatever Send would. */
async function sendNow() {
  if (composing && cardText.value.trim() !== "" && !(await addNote())) return;
  if (!sendButton.disabled) sendForm.requestSubmit();
}

// The same keys in the chrome itself, outside the fields it has the reviewer type in.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.altKey || endDialog.open) return;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendNow();
  } else if (
    event.key === "a" &&
    !event.metaKey &&
    !event.ctrlKey &&
    // Annotate off closes the card, so A never fires while a note is being written.
    !composing &&
    !(event.target instanceof HTMLTextAreaElement)
  ) {
    event.preventDefault();
    annotateSwitch.click();
  }
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending.length === 0) return;
  if (!(await saveEdit())) return;
  sending = true;
  problem = null;
  render();
  try {
    await api("POST", `/api/${key}/prompts`);
    ({ chat, drafts: pending } = await api("GET", `/api/${key}/session`));
  } catch (error) {
    problem = `Could not send: ${error.message}`;
  } finally {
    sending = false;
  }
  notesChanged();
});

let adding = false;
card.addEventListener("submit", (event) => {
  event.preventDefault();
  addNote();
});

/** Adds the note in the card; true when the server kept it and the card closed. */
async function addNote() {
  const prompt = cardText.value.trim();
  if (!composing || prompt === "" || adding) return false;
  // The instruction is this textarea's value; the other fields are copied by name from the target
  // the artifact proposed, so nothing else it sent rides along and nothing it sent can displace
  // `prompt`. This is the only path that adds a note, and it runs only on the reviewer's submit;
  // the server stamps it, so the moment the reviewer wrote it survives a batched send.
  const { selector, lines, tag, text, target, answers } = composing.note;
  adding = true;
  const kept = await changeDrafts("add the note", "POST", `/api/${key}/drafts`, {
    draft: { selector, lines, tag, text, target, answers, prompt },
    structure: composing.structure,
  });
  adding = false;
  // A note the server did not take stays in the card, still typed, beside the reason.
  if (kept) closeCompose(true);
  return kept;
}
cardText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendNow();
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    card.requestSubmit();
  } else if (event.key === "Escape") {
    // Handled here, so said to be: an Escape left unhandled goes on to the browser, which on macOS
    // offers it to its menus, and a headless browser froze whole doing so on the second Escape.
    event.preventDefault();
    closeCompose(true);
  }
});
cardCancel.addEventListener("click", () => closeCompose(true));

boot();
