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
async function devToolsUrl(child, executable, profile) {
  const portFile = join(profile, "DevToolsActivePort");
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
    const [port, path] = (existsSync(portFile) ? readFileSync(portFile, "utf8") : "").split("\n");
    if (/^\d+$/.test(port ?? "") && path?.startsWith("/")) return `ws://127.0.0.1:${port}${path}`;
    await sleep(STARTUP_POLL_MS);
  }
  throw new Error(
    `${executable} started but was not detected: it is still running and wrote no DevTools ` +
      `port to ${portFile} within ${STARTUP_MS} ms. It printed: ${said()}`,
  );
}

export async function launchBrowser(executable, { width = 1200, height = 800 } = {}) {
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
    rmSync(profile, { recursive: true, force: true });
  };
  let browser;
  try {
    browser = await connect(await devToolsUrl(child, executable, profile));
  } catch (error) {
    // The one line the incident turned on: a browser nobody kills keeps the suite alive
    // long after it has a verdict, and the verdict never gets printed.
    await discard();
    throw error;
  }
  return {
    pid: child.pid,
    async page(url) {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const page = new Page(browser, sessionId, targetId);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
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
    await loaded;
  }

  /** A real reload, since navigating to the same URL with a different fragment loads nothing. */
  async reload() {
    const loaded = this.loaded();
    await this.send("Page.reload");
    await loaded;
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
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? "evaluation failed");
    return result.value;
  }

  /** Polls an expression until it is truthy; the returned value is what made it so. */
  async waitFor(expression, { timeoutMs = 10_000, everyMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.eval(expression);
      if (value) return value;
      await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }

  async click(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  /**
   * The artifact runs in a sandboxed, opaque-origin iframe, which Chromium puts in its own
   * process: it never appears in this page's frame tree, so a test reads its DOM through
   * an auto-attached session of its own. Input still goes to the page, in page coordinates.
   */
  async frame() {
    const attached = new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        clearTimeout(timer);
        this.browser.listeners.splice(this.browser.listeners.indexOf(listener), 1);
        fn(value);
      };
      const listener = (message) => {
        if (message.method !== "Target.attachedToTarget") return;
        if (message.params.targetInfo.type !== "iframe") return;
        settle(resolve, message.params.sessionId);
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`waited ${ATTACH_MS} ms for the artifact iframe to attach`)),
        ATTACH_MS,
      );
      this.browser.listeners.push(listener);
    });
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    return new Page(this.browser, await attached);
  }

  /**
   * Input is routed by the browser's hit-test data, and for an out-of-process frame that
   * data lands some time after the frame has painted; until it does, a press aimed at the
   * frame is delivered to the page instead and selects nothing. Move the pointer until the
   * frame says it saw it, and every later event routes there too.
   */
  async pointerInto(frame, point, { timeoutMs = 5000 } = {}) {
    await frame.eval(`(() => {
      globalThis.sawPointer = false;
      if (!globalThis.watchingPointer) {
        globalThis.watchingPointer = true;
        document.addEventListener("mousemove", () => { globalThis.sawPointer = true; });
      }
      return 1;
    })()`);
    const deadline = Date.now() + timeoutMs;
    do {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
      });
      if (await frame.eval("globalThis.sawPointer")) return;
      await sleep(25);
    } while (Date.now() < deadline);
    throw new Error(`the pointer never reached the frame at ${point.x},${point.y}`);
  }

  /** A press, a path and a release: what makes the browser build a real text selection. */
  async drag(from, to, steps = 8) {
    const move = (type, x, y, buttons) =>
      this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    // A real pointer is somewhere before it presses, and Chromium hit-tests the press
    // against where it last saw the cursor; without this the press can land on nothing.
    await move("mouseMoved", from.x, from.y, 0);
    await move("mousePressed", from.x, from.y, 1);
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

export async function screenshot(page, file) {
  const { writeFileSync } = await import("node:fs");
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(data, "base64"));
}
