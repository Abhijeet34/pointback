// A minimal Chrome DevTools Protocol client on Node's own WebSocket: enough to open a page,
// evaluate script, and send real key and mouse events, with no browser-automation dependency.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../../src/identity.js";

const KNOWN_BROWSERS = [
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
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`browser exited ${code}: ${text}`)));
    setTimeout(() => reject(new Error(`browser gave no DevTools URL: ${text}`)), 15_000).unref();
  });
  const browser = await connect(wsUrl);
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
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await browser.send("Browser.close").catch(() => {});
      browser.socket.close();
      // A browser that ignores the polite request is not left behind.
      const forced = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(forced);
    },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;
    socket.addEventListener("open", () =>
      resolve({
        socket,
        listeners,
        send(method, params = {}, sessionId) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params, sessionId }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
      }),
    );
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
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
    return new Promise(
      /** @param {(value?: unknown) => void} resolve */ (resolve) => {
        const listener = (message) => {
          if (message.sessionId === this.sessionId && message.method === "Page.loadEventFired") {
            this.browser.listeners.splice(this.browser.listeners.indexOf(listener), 1);
            resolve();
          }
        };
        this.browser.listeners.push(listener);
      },
    );
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
    const attached = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "Target.attachedToTarget") return;
        if (message.params.targetInfo.type !== "iframe") return;
        this.browser.listeners.splice(this.browser.listeners.indexOf(listener), 1);
        resolve(message.params.sessionId);
      };
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
