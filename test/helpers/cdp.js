// A minimal Chrome DevTools Protocol client on Node's own WebSocket: enough to open a page,
// evaluate script, and send real key and mouse events, with no browser-automation dependency.
//
// Every wait here is bounded and every failure path kills the browser it spawned. Both rules
// come from one measured incident: on run 33788793925 the launch failed at 15 s, nothing
// killed the browser, and the live child process kept Node's event loop open until the job
// hit its own 20-minute limit and was reported `cancelled`. A test may fail; it may not hang.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../../src/identity.js";
import { until } from "./wait.js";

/**
 * A loaded runner is slow to hand a browser its first frame, and 15 s was not enough: on run
 * 33823294930 Chrome 152 was still alive and still starting up at 26.6 s, and the suite
 * called it dead. Detection below is a poll, so the happy path is unaffected by the ceiling
 * and only a genuine failure pays it. A bounded 45 s, never the 20-minute job timeout.
 */
const STARTUP_MS = 45_000;
/** Between two reads of the port file; a browser that is ready is picked up within one tick. */
const STARTUP_POLL_MS = 100;
/** Enough of the browser's own output to name a failure by, without holding a session of it. */
const STDERR_KEPT = 4000;
const CONNECT_MS = 10_000;
/** No DevTools command in this suite is slow; a reply that never comes is a dead browser. */
const COMMAND_MS = 30_000;
const TERMINATE_MS = 3000;
/** A page that never fires its load event is a dead navigation, not a slow one. */
const LOAD_MS = 15_000;
/** The iframe attaches within a paint or two of the page requesting it. */
const ATTACH_MS = 10_000;
const ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
/** How many of a page's document answers and console errors `describe` reports, newest last. */
const KEPT = 10;
/** One frame tree's share of `describe`: long enough for a slow runner, never a hang. */
const DESCRIBE_MS = 5000;
/**
 * Two launches, not one. On run 33874545761, attempt 2, chrome.exe on windows-2025 was still
 * running 45 s after it was spawned, had written no DevToolsActivePort and had printed nothing
 * at all - 1 of 20 identical runs of this suite, and it took every test in the file with it.
 * A cold browser launch is an operation that fails outright about that often on that runner,
 * and the suite gave it exactly one attempt. Lengthening STARTUP_MS would not have helped: the
 * browser was not slow, it was never coming.
 */
const LAUNCH_ATTEMPTS = 2;
/**
 * How long the browser's profile directory is worth trying to remove. Windows answers EPERM
 * while any of Chromium's helper processes still holds a file in it, and the top-level process
 * exiting is not the same fact.
 */
const PROFILE_REMOVE_MS = 30_000;

/**
 * Every path this repository knows a browser by, most specific first, and the one list of
 * them: the CI workflows resolve through `findBrowser` rather than naming a path of their
 * own, so a runner image that moves Chrome is a one-line change here and not a red release.
 */
export const KNOWN_BROWSERS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/brave-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findBrowser(environment = process.env) {
  const configured = env("BROWSER", environment);
  if (configured) return configured === "none" ? null : configured;
  return KNOWN_BROWSERS.find((path) => existsSync(path)) ?? null;
}

/** SIGTERM, then SIGKILL, then done: nothing this module spawns outlives the call that spawned it. */
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), TERMINATE_MS);
  return exited.finally(() => clearTimeout(forced));
}

/**
 * The DevTools endpoint, read from the file Chromium writes rather than the line it prints.
 * `<user-data-dir>/DevToolsActivePort` is written once the DevTools server is listening -
 * line 1 the port, line 2 the browser's websocket path - and a file is a guarantee where
 * stderr is not: on run 33823294930 a runner with no session bus printed four
 * `dbus/bus.cc:405` errors, buried the announcement, and the suite called a live browser
 * dead. Expected noise on a machine with no session bus must not read as a failure.
 *
 * The three things that go wrong here need three different fixes, so they get three
 * different sentences: no browser at all is `findBrowser` returning null before this is
 * ever called, a browser that would not start exits, and a browser that started but was
 * not detected is still running when the budget ends.
 */
export async function devToolsUrl(child, executable, profile) {
  const portFile = join(profile, "DevToolsActivePort");
  let unreadable = "";
  const read = (file) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch (error) {
      // Kept rather than swallowed: if the budget below runs out, this is the difference
      // between a browser that wrote no port and one whose port nothing could read.
      unreadable = ` The last read of it failed: ${error.message}.`;
      return "";
    }
  };
  let printed = "";
  // Never detached, unlike the listener this replaces: a piped stderr nobody reads fills
  // its buffer and stalls the browser writing to it, hours after the launch succeeded.
  child.stderr.on("data", (chunk) => {
    printed = (printed + chunk).slice(-STDERR_KEPT);
  });
  const said = () => printed.trim() || "(nothing)";

  const deadline = Date.now() + STARTUP_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${executable} would not start: it exited ${child.exitCode ?? child.signalCode} ` +
          `before opening a DevTools port. It printed: ${said()}`,
      );
    }
    // Chromium writes this file in one go, but a read that catches it half-written must
    // wait rather than parse a partial port, so both lines are checked before it is used.
    //
    // And on Windows the file can be locked while Chromium holds it, which makes the read
    // throw EBUSY rather than return a partial line. That threw out of this poll and failed
    // the whole browser suite in 5 of 20 consecutive runs on windows-2025 (run 33864656156).
    // A locked file is the same fact as an absent one - the port is not readable yet - so it
    // belongs in the loop, not in a stack trace.
    const [port, path] = read(portFile).split("\n");
    if (/^\d+$/.test(port ?? "") && path?.startsWith("/")) return `ws://127.0.0.1:${port}${path}`;
    await sleep(STARTUP_POLL_MS);
  }
  throw new Error(
    `${executable} started but was not detected: it is still running and wrote no readable ` +
      `DevTools port to ${portFile} within ${STARTUP_MS} ms.${unreadable} It printed: ${said()}`,
  );
}

/**
 * Removes the browser's profile, answering false for the errors Windows raises while a handle
 * on it is still open and throwing anything else, which is a real fault worth seeing.
 */
function removeProfile(profile) {
  try {
    rmSync(profile, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

export async function launchBrowser(executable, options = {}) {
  let failure;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    try {
      return await startBrowser(executable, options);
    } catch (error) {
      failure = error;
      if (attempt < LAUNCH_ATTEMPTS) {
        console.warn(
          `browser launch attempt ${attempt} of ${LAUNCH_ATTEMPTS} failed: ${error.message}`,
        );
      }
    }
  }
  throw failure;
}

async function startBrowser(executable, { width = 1200, height = 800 } = {}) {
  const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-browser-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      // A CI runner gives /dev/shm 64 MB where a desktop gives it half of RAM, and
      // Chromium's default shared-memory backing store takes a renderer down when it
      // runs out. On a machine with a real /dev/shm this only moves those pages to
      // a temporary file.
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const discard = async () => {
    await terminate(child);
    // The child exiting is not every handle on this directory being released: Chromium's
    // helper processes outlive it, and Windows answers EPERM to the removal until the last
    // of them has gone. rmSync's own retries were set at 20 x 100 ms and run 33874545761,
    // attempt 9, still came back EPERM out of `after()` - failing a file in which every test
    // had passed. Removing a temporary directory is cleanup, not an assertion: try for a real
    // budget, then say what was left behind rather than reddening a green file over a handle
    // the runner had not let go of yet.
    const gone = await until(() => removeProfile(profile), {
      what: `the browser profile ${profile} to become removable`,
      timeoutMs: PROFILE_REMOVE_MS,
      everyMs: 250,
      minAttempts: 10,
    }).catch(() => false);
    if (!gone) {
      console.warn(
        `the browser profile ${profile} was still locked after ${PROFILE_REMOVE_MS} ms; ` +
          `leaving it for the runner to reclaim`,
      );
    }
  };
  let browser;
  try {
    browser = await connect(await devToolsUrl(child, executable, profile));
    // Every renderer that crashes, with the address it held, for `describe` to name.
    const urls = new Map();
    browser.crashes = [];
    browser.listeners.push(({ method, params }) => {
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged")
        urls.set(params.targetInfo.targetId, params.targetInfo.url);
      else if (method === "Target.targetCrashed")
        browser.crashes.push(`${urls.get(params.targetId) ?? params.targetId} (${params.status})`);
    });
    await browser.send("Target.setDiscoverTargets", { discover: true });
  } catch (error) {
    // The one line the incident turned on: a browser nobody kills keeps the suite alive
    // long after it has a verdict, and the verdict never gets printed.
    await discard();
    throw error;
  }
  return {
    pid: child.pid,
    /** A tab at the launch size, or at `viewport` for a case about one width. */
    async page(url, viewport = { width, height }) {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const page = new Page(browser, sessionId, targetId);
      await page.send("Page.enable");
      await page.watch();
      await page.send("Emulation.setDeviceMetricsOverride", {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.navigate(url);
      return page;
    },
    async close() {
      // The reply to Browser.close races the browser's own exit, so the request is sent
      // and never waited on; the signals in discard() are what actually end it.
      browser.send("Browser.close").catch(() => {});
      browser.socket.close();
      await discard();
    },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(`the browser opened no DevTools connection on ${url} within ${CONNECT_MS} ms`),
      );
    }, CONNECT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        socket,
        listeners,
        send(method, params = {}, sessionId) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params, sessionId }));
          return new Promise((res, rej) => {
            // Unref'd: while the socket is open it holds the loop and this still fires, and
            // once the socket is gone there is no caller left for it to keep waiting for.
            const deadline = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`the browser sent no reply to ${method} within ${COMMAND_MS} ms`));
            }, COMMAND_MS).unref();
            const done = (fn) => (value) => {
              clearTimeout(deadline);
              fn(value);
            };
            pending.set(id, { res: done(res), rej: done(rej) });
          });
        },
      });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`cannot connect to ${url}`));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (!waiter) return; // its deadline already passed and its caller has moved on
        if (message.error) waiter.rej(new Error(message.error.message));
        else waiter.res(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
  });
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  /** Chromium starves a background tab's queued tasks, so a test drives the tab a reviewer sees. */
  front() {
    return this.send("Page.bringToFront");
  }

  close() {
    return this.browser.send("Target.closeTarget", { targetId: this.targetId });
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async navigate(url) {
    const loaded = this.loaded();
    await this.send("Page.navigate", { url });
    await this.explained(loaded);
  }

  /** A real reload, since navigating to the same URL with a different fragment loads nothing. */
  async reload() {
    const loaded = this.loaded();
    await this.send("Page.reload");
    await this.explained(loaded);
  }

  loaded() {
    return new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        clearTimeout(timer);
        this.browser.listeners.splice(this.browser.listeners.indexOf(listener), 1);
        fn(value);
      };
      const listener = (message) => {
        if (message.sessionId === this.sessionId && message.method === "Page.loadEventFired") {
          settle(resolve);
        }
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`waited ${LOAD_MS} ms for the page to fire its load event`)),
        LOAD_MS,
      );
      this.browser.listeners.push(listener);
    });
  }

  /** Evaluates an expression in the page's own (top) context and returns its JSON value. */
  async eval(expression, contextId) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      contextId,
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? "evaluation failed");
    return result.value;
  }

  /** The DOM root of this page's document, for DOM and CSS domain queries. */
  async document() {
    return (await this.send("DOM.getDocument")).root;
  }

  /**
   * Polls an expression until it is truthy; the returned value is what made it so. Bounded
   * by attempts as well as by the clock, because each poll is a DevTools round trip and
   * `until` in helpers/wait.js carries the measurement of what one of those can cost.
   */
  waitFor(expression, options = {}) {
    return this.explained(until(() => this.eval(expression), { what: expression, ...options }));
  }

  /**
   * A wait on a watched tab, or on the page under review in one, that fails says what the tab showed
   * instead (`describe`); one already explained by a wait inside it is passed on as it is.
   */
  explained(waited) {
    const tab = this.documents ? this : this.tab;
    if (!tab) return waited;
    return waited.catch(async (error) => {
      if (error.explained) throw error;
      const described = new Error(`${error.message}\n  ${await tab.describe()}`, { cause: error });
      throw Object.assign(described, { explained: true });
    });
  }

  async click(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  /**
   * The page under review. The chrome frames pointback's wrapper, served under the other loopback
   * name, and the wrapper frames the page, which is sandboxed and so goes to a process of its own:
   * an auto-attached target whose root frame is the page. A browser that keeps the page in its
   * parent's process makes it a child frame instead, reached by its frame id and the execution
   * context its document gets; that is found too. Input still goes to the chrome page, in its
   * coordinates.
   *
   * Resolves once the page's own document is there, never a frame's initial blank one, and after a
   * reload with the new document's frame, so a caller asks for it after the navigation it awaits.
   * A tab's first show is one of those: a first load that never announces itself is shown once more,
   * so the page is looked for only once the chrome has heard one announce itself. A handle on the
   * document the chrome replaces is answered "Inspected target navigated or closed" mid-wait, as on
   * windows-2025, run 37299968339, attempt 7, and 2 of 900 local runs of its sdk.js test at 0d46b08.
   *
   * It also waits for the page to have a viewport. The frame the wrapper creates can finish loading
   * before it is given its size, and until then nothing in it is laid out: every rect reads 0x0, so
   * a point measured from one aims at the frame's rounded corner, which hit-tests to the chrome.
   * Measured on windows-2025, run 37089815210: 8 of 20 attempts read innerWidth 0 at "complete".
   */
  async frame() {
    await this.watch();
    await this.waitFor("document.body.dataset.ready === '1'", { timeoutMs: ATTACH_MS });
    const artifact = await this.explained(
      until(() => this.#findArtifact(), {
        what: "the page under review to load in its frame",
        timeoutMs: ATTACH_MS,
      }),
    );
    artifact.tab = this;
    await artifact.waitFor("innerWidth > 0 && innerHeight > 0", { timeoutMs: ATTACH_MS });
    return artifact;
  }

  /**
   * Tracks this page's iframe targets and their contexts, and keeps what `describe` reports. A tab
   * is watched from its creation, so a page that never gets ready can say why on its first load.
   */
  async watch() {
    if (this.children) return;
    this.children = new Map();
    this.contexts = new Map();
    this.documents = [];
    this.errors = [];
    this.failed = [];
    this.requests = new Map();
    this.browser.listeners.push((message) => this.#track(message));
    // Enabled again so the contexts this page already has are announced to the tracker too.
    await this.send("Runtime.disable");
    for (const command of ["Runtime.enable", "Network.enable", "Log.enable"])
      await this.send(command);
    await this.send("Target.setAutoAttach", ATTACH);
  }

  /**
   * What a wait that failed on this page cannot see for itself: what the chrome shows and where its
   * focus is, with its event stream's state, every frame's address, the answers its documents got,
   * the loads that got none, its last console errors, and any renderer that crashed. On run
   * 37247968168, attempt 20, a reloaded review never got ready in 10 s while the browser answered
   * every 31 ms, and the timeout was all it said.
   */
  async describe() {
    // `presence` reads `lost` or `gone` while the event stream is down, the agent's state while up.
    const shown = await Promise.race([
      this.eval(`JSON.stringify({
        status: document.getElementById("status")?.textContent,
        notice: document.getElementById("notice")?.hidden === false
          ? document.getElementById("noticeText").textContent : null,
        stream: document.getElementById("presence")?.dataset.state,
        focus: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
        body: { ...document.body?.dataset },
      })`),
      sleep(DESCRIBE_MS, "no answer", { ref: false }),
    ]).catch((error) => `unreadable: ${error.message}`);
    const frames = [];
    const walk = (node) => {
      const { url, unreachableUrl } = node.frame;
      frames.push(unreachableUrl ? `${url} in place of ${unreachableUrl}` : url);
      for (const child of node.childFrames ?? []) walk(child);
    };
    // A crashed frame's session never answers, so every tree is asked at once and given DESCRIBE_MS.
    const trees = await Promise.all(
      [this.sessionId, ...this.children.keys()].map((session) =>
        Promise.race([
          this.browser.send("Page.getFrameTree", {}, session).then(
            (answer) => answer.frameTree,
            () => null,
          ),
          sleep(DESCRIBE_MS, null, { ref: false }),
        ]),
      ),
    );
    for (const tree of trees) if (tree) walk(tree);
    const list = (items) =>
      items.length ? items.map((item) => `\n    ${item}`).join("") : " none";
    return (
      `the chrome shows ${shown}\n  frames:${list(frames)}\n  documents answered:${list(this.documents)}` +
      `\n  loads failed:${list(this.failed)}\n  console errors:${list(this.errors)}` +
      `\n  crashed renderers:${list(this.browser.crashes)}`
    );
  }

  /** Every iframe target under this page, and the default execution context of each frame in them. */
  #track({ method, params, sessionId }) {
    const ours = sessionId === this.sessionId || this.children.has(sessionId);
    if (!ours) return;
    const keep = (items, item) => items.push(item) > KEPT && items.shift();
    const where = sessionId === this.sessionId ? "chrome" : "frame";
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
      this.children.set(params.sessionId, sessionId);
      // A target's own iframes attach only when its own session asks for them.
      for (const command of ["Runtime.enable", "Page.enable", "Network.enable", "Log.enable"])
        this.browser.send(command, {}, params.sessionId).catch(() => {});
      this.browser.send("Target.setAutoAttach", ATTACH, params.sessionId).catch(() => {});
    } else if (method === "Network.responseReceived" && params.type === "Document") {
      keep(this.documents, `${params.response.status} ${params.response.url}`);
    } else if (method === "Network.requestWillBeSent") {
      this.requests.set(`${sessionId} ${params.requestId}`, params.request.url);
    } else if (method === "Network.loadingFinished") {
      this.requests.delete(`${sessionId} ${params.requestId}`);
    } else if (method === "Network.loadingFailed") {
      // A load that never got an answer has no response to list above, and the console names only
      // some of them: a frame's own document that failed shows as an error page and nothing else.
      const request = `${sessionId} ${params.requestId}`;
      const url = this.requests.get(request) ?? "sent before its frame was watched";
      this.requests.delete(request);
      const how = `${params.errorText}${params.canceled ? " (canceled)" : ""}`;
      keep(this.failed, `${where}: ${how} ${params.type} ${url}`);
    } else if (method === "Runtime.exceptionThrown") {
      const { exception, text } = params.exceptionDetails;
      keep(this.errors, `${where}: ${exception?.description ?? text}`);
    } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      const text = params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      keep(this.errors, `${where}: console.error ${text}`);
    } else if (method === "Log.entryAdded" && params.entry.level === "error") {
      keep(this.errors, `${where}: ${params.entry.text} ${params.entry.url ?? ""}`.trim());
    } else if (method === "Target.detachedFromTarget") {
      this.children.delete(params.sessionId);
    } else if (method === "Runtime.executionContextCreated") {
      const { id, auxData } = params.context;
      if (auxData?.isDefault) this.contexts.set(`${sessionId} ${auxData.frameId}`, id);
    } else if (method === "Runtime.executionContextDestroyed") {
      for (const [key, id] of this.contexts)
        if (id === params.executionContextId) this.contexts.delete(key);
    } else if (method === "Runtime.executionContextsCleared") {
      for (const key of this.contexts.keys())
        if (key.startsWith(`${sessionId} `)) this.contexts.delete(key);
    }
  }

  async #findArtifact() {
    const trees = new Map();
    for (const session of [this.sessionId, ...this.children.keys()]) {
      const tree = await this.browser
        .send("Page.getFrameTree", {}, session)
        .then((answer) => answer.frameTree)
        .catch(() => null);
      if (tree) trees.set(session, tree);
    }
    const isPage = (url) => /\/artifact\//.test(url);
    for (const [session, tree] of trees) {
      if (session !== this.sessionId && isPage(tree.frame.url))
        return new Page(this.browser, session);
    }
    // The outermost frame at a page's address; the page's own frames are below it.
    const outermost = (node) =>
      isPage(node.frame.url) ? node.frame : (node.childFrames ?? []).map(outermost).find(Boolean);
    for (const [session, tree] of trees) {
      const frame = outermost(tree);
      if (frame && frame !== tree.frame) {
        return new ArtifactFrame(this.browser, session, frame.id, () =>
          this.contexts.get(`${session} ${frame.id}`),
        );
      }
    }
    return null;
  }

  /**
   * Input is routed by the browser's hit-test data, and for an out-of-process frame that
   * data lands some time after the frame has painted; until it does, a press aimed at the
   * frame is delivered to the page instead and selects nothing. Move the pointer until the
   * frame says it saw it, and every later event routes there too.
   *
   * Counted in moves, not only in milliseconds. On run 33874545761, attempt 8, this failed
   * having dispatched exactly one move in 5000 ms: a single DevTools round trip on that
   * runner cost about five seconds, so the whole budget bought one look. The wait now makes
   * at least `attempts` moves whatever they cost, which is what "waited" was meant to mean.
   *
   * Returns the moves it took and the milliseconds they cost, so a caller can report what
   * this ran into on a given runner without asserting the runner's speed.
   */
  async pointerInto(frame, point, { attempts = 40, timeoutMs = 5000 } = {}) {
    // Armed inside the loop rather than once in front of it. The flag this polls lives in
    // the frame's document, and a document replaced under the wait takes the listener with
    // it: a one-time arming then leaves the poll reading a value nothing will ever set
    // again, so the only outcome left is the full budget and a timeout. The guard is per
    // document, so this registers once per document and never stacks listeners.
    const armAndRead = `(() => {
      if (!globalThis.watchingPointer) {
        globalThis.watchingPointer = true;
        globalThis.sawPointer = false;
        document.addEventListener("mousemove", () => { globalThis.sawPointer = true; });
      }
      return globalThis.sawPointer;
    })()`;
    // A second call to a point the pointer already reached must verify that point rather
    // than read the first call's answer, so the flag starts each call false; arming here
    // as well is what lets the first move below be the one that lands.
    await frame.eval("globalThis.sawPointer = false");
    await frame.eval(armAndRead);
    let moves = 0;
    const started = Date.now();
    try {
      await until(
        async () => {
          moves += 1;
          await this.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
          });
          return frame.eval(armAndRead);
        },
        { what: "the frame to see the pointer", timeoutMs, everyMs: 25, minAttempts: attempts },
      );
      return { moves, ms: Date.now() - started };
    } catch {
      // fall through to the diagnosis below, which is worth more than `until`'s own message
    }
    // Three different things end up here and they need three different fixes, so the
    // message separates them rather than leaving the next reader a coordinate to guess
    // from: the page naming something other than the frame at that point is geometry
    // measured too early, the frame having lost the flag set two lines above is a
    // document replaced under the test, and neither of those is input that was routed
    // to the page and never handed on.
    const at = await this.eval(
      `(() => { const e = document.elementFromPoint(${point.x}, ${point.y}); return e ? e.id || e.tagName : "nothing"; })()`,
    );
    const watching = await frame.eval("typeof globalThis.sawPointer");
    throw new Error(
      `the pointer never reached the frame at ${point.x},${point.y}: ${moves} moves over ` +
        `${Date.now() - started} ms, the page has "${at}" at that point, and the frame's own flag is ` +
        `${watching}${watching === "undefined" ? " (its document was replaced under the test)" : ""}` +
        (this.documents ? `\n  ${await this.describe()}` : ""),
    );
  }

  /**
   * A press, a path and a release: what makes the browser build a real text selection.
   * `pressed` runs while the button is held, before the first move.
   */
  async drag(from, to, { pressed } = {}) {
    const steps = 8;
    const move = (type, x, y, buttons) =>
      this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    // A real pointer is somewhere before it presses, and Chromium hit-tests the press
    // against where it last saw the cursor; without this the press can land on nothing.
    await move("mouseMoved", from.x, from.y, 0);
    await move("mousePressed", from.x, from.y, 1);
    await pressed?.();
    for (let step = 1; step <= steps; step += 1) {
      const at = (a, b) => a + ((b - a) * step) / steps;
      await move("mouseMoved", at(from.x, to.x), at(from.y, to.y), 1);
    }
    await move("mouseReleased", to.x, to.y, 0);
  }

  /**
   * @param {string} key
   * @param {{ code?: string, keyCode?: number, text?: string, modifiers?: number }} [options]
   */
  async key(key, { code = key, keyCode, text, modifiers = 0 } = {}) {
    const base = {
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      text,
      ...base,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  tab() {
    return this.key("Tab", { keyCode: 9 });
  }

  enter() {
    return this.key("Enter", { keyCode: 13, text: "\r" });
  }

  /** Shift is modifier bit 8; the SDK reads shiftKey to grow the selection a word at a time. */
  shiftArrow(direction) {
    const right = direction === "right";
    return this.key(right ? "ArrowRight" : "ArrowLeft", { keyCode: right ? 39 : 37, modifiers: 8 });
  }

  type(text) {
    return this.send("Input.insertText", { text });
  }
}

/**
 * The page under review as a child frame of the wrapper's target: its expressions run in the
 * default context of its current document, which a reload replaces, and its DOM is the content
 * document of its frame. Accessibility queries name the frame with `frameId`.
 */
class ArtifactFrame extends Page {
  constructor(browser, sessionId, frameId, context) {
    super(browser, sessionId);
    this.frameId = frameId;
    this.context = context;
  }

  async eval(expression) {
    // A navigation replaces the document between finding its context and using it; the context
    // a reload leaves behind is gone, and the next one is the one to ask.
    for (let attempt = 1; ; attempt += 1) {
      const id = await this.explained(
        until(() => this.context(), {
          what: "the page under review to have a document to evaluate in",
          timeoutMs: ATTACH_MS,
        }),
      );
      try {
        return await super.eval(expression, id);
      } catch (error) {
        if (attempt >= 5 || !/context/i.test(error.message)) throw error;
      }
    }
  }

  async document() {
    const { root } = await this.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (node) =>
      node.frameId === this.frameId && node.contentDocument
        ? node.contentDocument
        : [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]
            .map(find)
            .find(Boolean);
    return find(root);
  }
}

export async function screenshot(page, file) {
  const { writeFileSync } = await import("node:fs");
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(data, "base64"));
}
