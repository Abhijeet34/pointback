// The core act in the engines the CLI may hand a review to: it opens the reviewer's default
// browser, which is Safari on an unconfigured Mac, while test/browser.test.js drives Chromium
// only. Open a file, point at an element, write a note, send, and a poll returns it. Then the gate
// these engines need (docs/THREAT-MODEL.md): a page acting on the card's Enter gets nothing.
// Keys pressed after a note made by mouse edit nothing in the page.
// And an add after the tab sat idle past Node's default keep-alive close is kept.
// And a chrome face refused while the browser is offline leaves the review on screen.
// The chrome, a rendered Markdown page and its pin follow a light and a dark preference.
// `npm run smoke -- webkit firefox`; weekly and on the release pull request in
// .github/workflows/cross-platform.yml.
// The chrome's CSP refuses string evaluation, so page-side waits are functions run in the tab.
/* global document, location, getComputedStyle */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox, webkit } from "playwright-core";
import { serve } from "../src/server.js";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";
import { contrast, decodePng } from "./helpers/png.js";
import { until } from "./helpers/wait.js";

const HOSTILE = new URL("./fixtures/hostile-after-gesture.html", import.meta.url);
const FOCUS_CALLS = new URL("./fixtures/focus-calls.html", import.meta.url);
const UNLOAD_ROUNDS = 5;
const UNLOADED_LINE =
  "This page was unloaded because it took the keyboard from your note. It comes back when you finish the note.";

const ENGINES = { webkit, firefox };
/** The longest any one Playwright wait may take; nothing in the act is slow, so a miss is a hang. */
const STEP_MS = 30_000;
const NOTE = "Make the title shorter";
// `ACTIVATION_MS` in src/browser/chrome.js: how long the chrome hears nothing from the page after a key.
const GATE_MS = 5000;

async function smoke(engine) {
  const lab = isolatedEnv();
  let browser;
  // The summary names the version that failed as well as the one that passed.
  let named = `${engine} (did not launch)`;
  try {
    browser = await ENGINES[engine].launch({ timeout: STEP_MS * 2 });
    named = `${engine} ${browser.version()}`;
    await act(browser, (page) => coreAct(page, lab));
    await act(browser, (page) => enterIsNotThePages(page, lab));
    await act(browser, (page) => clickInsideTheGate(page, lab));
    await act(browser, (page) => endKeepsTheCard(page, lab));
    await act(browser, (page) => readingPlace(page, lab, engine));
    await act(browser, (page) => pressOverThePage(page, lab));
    await act(browser, (page) => keysAfterAMouseNote(page, lab, engine));
    const control = await act(browser, (page) => keysReachThePage(page, lab, engine));
    const probes = [];
    const ms = [];
    for (let round = 1; round <= UNLOAD_ROUNDS; round += 1) {
      const result = await act(browser, (page) => unloadRound(page, lab, engine, round));
      probes.push(result.probe);
      ms.push(result.ms);
    }
    await act(browser, (page) => focusLeavesNoteAlone(page, lab, engine));
    await act(browser, addAfterAnIdle);
    await act(browser, (page) => faceRefusedOffline(page, lab, engine));
    const schemes = [];
    for (const colorScheme of ["light", "dark"]) {
      schemes.push(
        await act(browser, (page) => followsScheme(page, lab, colorScheme), { colorScheme }),
      );
    }
    return `${named} passed; ${schemes.join("; ")}; unloaded in ${UNLOAD_ROUNDS} of ${UNLOAD_ROUNDS} rounds; probe keys reaching the page per round ${probes.join(", ")}; move to unloaded ms per round ${ms.join(", ")}; the key channel reported ${control} keys of the page's own`;
  } catch (error) {
    throw Object.assign(error, { named });
  } finally {
    await browser?.close();
    await lab.stop();
  }
}

/**
 * Each act on a page of its own, closed when the act ends, so no act inherits another's tab. A
 * failed act says what the chrome showed, as `describe` in test/helpers/cdp.js does for Chromium:
 * a timeout alone cannot tell a key that missed the card from a page that never loaded.
 */
async function act(browser, fn, options = {}) {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(STEP_MS);
  try {
    return await fn(page);
  } catch (error) {
    const shown = await page
      .evaluate(() => ({
        url: location.href.replace(/#.*/, "#..."),
        ready: document.body?.dataset.ready,
        focus: document.hasFocus(),
        active: document.activeElement?.id || document.activeElement?.tagName,
        card: document.getElementById("card")?.hidden === false,
        // A closed card keeps the last note's words until the next one opens it empty.
        text:
          document.getElementById("card")?.hidden === false
            ? document.getElementById("cardText").value
            : null,
        marks: document.querySelectorAll(".mark:not(.sent)").length,
        sent: document.querySelectorAll(".mark.sent").length,
        notice: document.getElementById("noticeText")?.textContent,
        reason: document.getElementById("cardReason")?.hidden
          ? null
          : document.getElementById("cardReason")?.textContent,
        add: document.getElementById("cardAdd")?.disabled ? "disabled" : "enabled",
        stream: document.getElementById("presence")?.dataset.state,
        status: document.getElementById("status")?.textContent,
      }))
      .catch((reason) => `unreadable: ${reason.message.split("\n")[0]}`);
    // The verdict prints the stack, which V8 composed when the error was made.
    error.stack = `${error.stack}\n  the chrome showed ${JSON.stringify(shown)}`;
    throw error;
  } finally {
    await page.close();
  }
}

/**
 * Opens a review the way the reviewer's browser does, and waits on the chrome's own word that the
 * page under review is shown. Not `page.goto`, which waits on Playwright's record of the main
 * frame's load: on CI Firefox runs on main timed out there while the chrome showed the review,
 * `ready` set, frames loaded and nothing pending, and a pages-closed variant tested just before
 * the change timed out the same way.
 */
async function open(page, url) {
  await page.evaluate((href) => setTimeout(() => location.assign(href)), url);
  await page.waitForFunction(() => document.body?.dataset.ready === "1");
}

/**
 * Open a file, point at an element, write a note, send, and a poll returns it. The page and the
 * frame it is shown in each load once: WebKit loaded both twice, and its second page replaced the
 * frame under whatever the reviewer was doing in the first. Nothing logs a console error on the way:
 * WebKit logged one on every load for a message the chrome posted before its frame listened.
 */
async function coreAct(page, lab) {
  const loads = { page: 0, wrapper: 0 };
  page.on("framenavigated", (frame) => {
    if (frame.url().includes("/artifact/")) loads.page += 1;
    else if (frame.url().endsWith("/wrapper.html")) loads.wrapper += 1;
  });
  const errors = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  const { session } = (await cli([fixture], lab.env)).json();
  await open(page, session.url);
  // Annotate starts on; the click below is the reviewer's gesture the chrome waits for.
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  // The page under review sits in pointback's wrapper frame, inside the chrome's own.
  await page.frameLocator("#artifact").frameLocator("#page").locator("#title").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.type(NOTE);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".mark:not(.sent)").length === 1);

  await page.click("#send");
  // After the click, not racing it: a sent batch waits on the server, and a poll left
  // pending behind a stalled click would reject with nothing to report it.
  const polled = (await cli(["poll", fixture, "--timeout-ms", "10000"], lab.env)).json();
  assert.equal(polled.status, "feedback");
  assert.deepEqual(
    polled.prompts.map(({ prompt, selector, tag }) => ({ prompt, selector, tag })),
    [{ prompt: NOTE, selector: "#title", tag: "h1" }],
  );
  // Read once the note made in the page has come back: the chrome heard the page's load before the
  // note it proposed, and showing it again is decided only there, so no load is still to come.
  assert.deepEqual(loads, { page: 1, wrapper: 1 }, "the page and its wrapper loaded once each");
  assert.deepEqual(errors, [], "the review logged no console error");
}

/**
 * Firefox and WebKit pass a key pressed in the chrome on to the page, so the page could spend the
 * reviewer's Enter in the card; the chrome hears nothing from the page for 5 s after a key there.
 * The page tries again on every target the chrome hands back, until well after the gate lapses.
 */
async function enterIsNotThePages(page, lab) {
  const dir = join(lab.dir, "review");
  mkdirSync(dir);
  const file = join(dir, "rollout.html");
  copyFileSync(HOSTILE, file);
  const tries = [];
  page.on("console", (message) => {
    const at = /^hostile tried at (\d+)$/.exec(message.text())?.[1];
    if (at) tries.push(Number(at));
  });
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  const artifact = page.frames().find((frame) => frame.url().includes("/artifact/"));
  // Before the click, whose gesture is let lapse below along with this evaluate's.
  await artifact.evaluate(() => (globalThis.retry = true));
  await page.frameLocator("#artifact").frameLocator("#page").locator("#p1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  // The click is the reviewer's own gesture in the page, which the page may use; it is let lapse,
  // so all that is left to spend is the Enter. Inserted text presses no key.
  await page.waitForFunction(() => !navigator.userActivation.isActive);
  await page.keyboard.insertText(NOTE);
  await page.keyboard.press("Enter");
  // The gate has lapsed by then: it began at the Enter's keydown, before the press returned.
  const lapsed = Date.now() + GATE_MS;
  // The chrome's own account that the Enter landed in the card: closed, the note kept unsent. A key
  // that went elsewhere fails here by name rather than as the page's silence below.
  await page.waitForFunction(
    () =>
      document.getElementById("card").hidden &&
      document.querySelectorAll(".mark:not(.sent)").length === 1,
  );
  // Each try follows the chrome's answer to the one before, so a second report stamped after the
  // lapse means tries made after it were handled. Nothing here evaluates in the page's frames.
  await until(() => tries.filter((at) => at > lapsed).length >= 2, {
    what: "two reports of the page's tries after the gate lapsed",
    timeoutMs: STEP_MS,
  });
  assert.deepEqual(
    await page.evaluate(() => ({
      card: !document.getElementById("card").hidden,
      sent: document.querySelectorAll(".mark.sent").length,
    })),
    { card: false, sent: 0 },
    "the page neither opened the card nor sent the note on the reviewer's Enter",
  );
  const polled = (await cli(["poll", file, "--timeout-ms", "0"], lab.env)).json();
  assert.equal(polled.status, "waiting", "the agent receives nothing the reviewer did not send");
}

/**
 * The ordinary rhythm of a review: add a note with Enter and click the next thing at once. The gate
 * drops that click, and must hand the page back, so the click after the gate lapses opens the card.
 */
async function clickInsideTheGate(page, lab) {
  const dir = join(lab.dir, "quick");
  mkdirSync(dir);
  const file = join(dir, "plan.html");
  copyFileSync(fixture, file);
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  const view = page.frameLocator("#artifact").frameLocator("#page");
  await view.locator("#title").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.type(NOTE);
  const pressing = Date.now();
  await page.keyboard.press("Enter");
  // The gate began at the Enter's keydown, between these two.
  const lapsed = Date.now() + GATE_MS;
  await page.waitForFunction(() => document.getElementById("card").hidden);
  const p1 = view.locator("#p1");
  await p1.click();
  // The page reports this scroll behind the click's target through the same frames, so once the
  // chrome shows it, the chrome has handled the target.
  const y = await p1.evaluate((p) => {
    const win = p.ownerDocument.defaultView;
    win.scrollTo(0, win.scrollY + 7);
    return win.scrollY;
  });
  await page.waitForFunction((expected) => document.body.dataset.scroll === expected, String(y));
  const heard = Date.now() - pressing;
  assert.ok(heard < GATE_MS, `the click was handled ${heard} ms after Enter, outside the gate`);
  assert.equal(
    await page.evaluate(() => document.getElementById("card").hidden),
    true,
    "a click inside the gate opens no card",
  );
  // Nothing fires here; the wait only outlasts the gate.
  await new Promise((resolve) => setTimeout(resolve, lapsed - Date.now()));
  await view.locator("#risks").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.type("Name the owner");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".mark:not(.sent)").length === 2);
  await page.click("#send");
  const polled = (await cli(["poll", file, "--timeout-ms", "10000"], lab.env)).json();
  assert.deepEqual(
    polled.prompts?.map(({ prompt, selector }) => ({ prompt, selector })),
    [
      { prompt: NOTE, selector: "#title" },
      { prompt: "Name the owner", selector: "#risks" },
    ],
    "the click after the gate lapsed was noted, and the agent receives it",
  );
}

/** The agent's end, which closes the card for a reason not the reviewer's, leaves their words in it. */
async function endKeepsTheCard(page, lab) {
  const dir = join(lab.dir, "ending");
  mkdirSync(dir);
  const file = join(dir, "plan.html");
  copyFileSync(fixture, file);
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#title").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.type(NOTE);
  await cli(["end", file], lab.env);
  await page.waitForFunction(
    () => document.getElementById("noticeText").textContent === "Your agent ended this review.",
  );
  assert.equal(
    await page.evaluate(() =>
      document.getElementById("card").checkVisibility()
        ? document.getElementById("cardText").value
        : null,
    ),
    NOTE,
    "the card the end would have closed still shows the reviewer's words",
  );
}

/**
 * A box that stays on screen, here a sticky header, crosses the top of the window wherever the
 * reviewer is; the reload must restore against the in-flow page, so a banner added above section 30
 * leaves its heading where the reviewer had it.
 */
async function readingPlace(page, lab, engine) {
  const dir = mkdtempSync(join(tmpdir(), "pb-reading-"));
  try {
    const file = join(dir, "docs.html");
    const sections = Array.from(
      { length: 60 },
      (_, i) => `<section id="s${i}"><h2>Section ${i}</h2><p>Body of section ${i}.</p></section>`,
    ).join("");
    const save = (banner) => {
      const html = `<!doctype html><body style="margin:0"><header style="position:sticky;top:0;padding:12px">Docs</header>${banner}<main>${sections}</main></body>`;
      writeFileSync(`${file}.tmp`, html);
      renameSync(`${file}.tmp`, file);
    };
    save("");
    const { session } = (await cli([file], lab.env)).json();
    await open(page, session.url);
    await page.waitForFunction(() => document.body.dataset.revision === "0");
    const heading = page.frameLocator("#artifact").frameLocator("#page").locator("#s30 h2");
    const y = await heading.evaluate((h2) => {
      const win = h2.ownerDocument.defaultView;
      win.scrollTo(0, win.scrollY + h2.getBoundingClientRect().top - 120);
      return win.scrollY;
    });
    // This scroll's own report, not an earlier one, is what the reload restores from.
    await page.waitForFunction((expected) => document.body.dataset.scroll === expected, String(y));
    const before = await heading.evaluate((h2) => h2.getBoundingClientRect().top);
    save('<div style="height:300px">Banner the agent added</div>');
    await page.waitForFunction(() => document.body.dataset.revision === "1");
    const after = await heading.evaluate((h2) => h2.getBoundingClientRect().top);
    assert.ok(
      Math.abs(after - before) <= 2,
      `${engine}: section 30 moved from ${before} px to ${after} px from the top of the window`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A press over the page while a note has the focus is the reviewer's own move into the page, so the
 * engine must name the frame as where the focus went; if it does not, the chrome holds the page as
 * a steal and the page is not shown.
 */
async function pressOverThePage(page, lab) {
  const { session } = (await cli([fixture], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#title").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  const spot = await page.evaluate(() => {
    const frame = document.getElementById("artifact").getBoundingClientRect();
    const card = document.getElementById("card").getBoundingClientRect();
    const points = [
      [0.1, 0.9],
      [0.9, 0.9],
      [0.1, 0.1],
      [0.9, 0.1],
    ].map(([x, y]) => ({ x: frame.left + frame.width * x, y: frame.top + frame.height * y }));
    return points.find(
      ({ x, y }) => x < card.left || x > card.right || y < card.top || y > card.bottom,
    );
  });
  assert.ok(spot, "a point over the page outside the note card");
  await page.mouse.click(spot.x, spot.y);
  await page.waitForFunction(() => document.activeElement?.id === "artifact");
  assert.deepEqual(
    await page.evaluate(() => ({
      shown: getComputedStyle(document.getElementById("artifact")).display !== "none",
      cover: document.getElementById("cover").hidden,
    })),
    { shown: true, cover: true },
    "a press over the page is the reviewer's own move into it, so the page is not held",
  );
}

/** Every key the fixture reports, as `keydown o`, in the order the page received it. */
function listenForKeys(page) {
  const keys = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("focus-calls key ")) keys.push(text.slice("focus-calls key ".length));
  });
  return keys;
}

/**
 * Returns the key reports once none has arrived for eight polls in a row (about 200 ms), so a console
 * message still in flight is counted before the count is read.
 */
async function keysSettle(keys, what) {
  let last = -1;
  let still = 0;
  await until(
    () => {
      still = keys.length === last ? still + 1 : 0;
      last = keys.length;
      return still >= 8;
    },
    { what, timeoutMs: STEP_MS },
  );
  return keys.length;
}

/** Opens a private copy of the focus fixture as its own review, in the act's page. */
async function openFocusFixture(page, lab, dirName) {
  const dir = join(lab.dir, dirName);
  mkdirSync(dir);
  const file = join(dir, "incident.html");
  copyFileSync(FOCUS_CALLS, file);
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
}

/**
 * The page's own keys, with no note open, reach the console channel: the zero-key checks below are
 * trusted only once this has been seen to report a key in this engine.
 */
async function keysReachThePage(page, lab, engine) {
  await openFocusFixture(page, lab, "keys");
  const keys = listenForKeys(page);
  await page.evaluate(() => document.getElementById("annotate").click());
  await page.waitForFunction(() => document.body.dataset.annotate === "0");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#field").click();
  await page.keyboard.type("ok");
  await until(async () => keys.length >= 4, {
    what: `${engine}: the key channel to report the page's own keys`,
    timeoutMs: STEP_MS,
  });
  assert.deepEqual(keys.slice(0, 4), ["keydown o", "keyup o", "keydown k", "keyup k"], engine);
  return keys.length;
}

/**
 * Keys pressed once a note made by mouse is added reach no element of the page: the noted field keeps
 * its value, and the page has the focus back with nothing in it focused. A card Space might open is
 * not looked for, since the chrome hears nothing from the page for 5 s after the reviewer's Enter.
 */
async function keysAfterAMouseNote(page, lab, engine) {
  await openFocusFixture(page, lab, "mouse-note");
  const keys = listenForKeys(page);
  await page.frameLocator("#artifact").frameLocator("#page").locator("#field").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.insertText(NOTE);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("card").hidden && document.body.dataset.handoff === "settled",
  );
  const artifact = page.frames().find((frame) => frame.url().includes("/artifact/"));
  await artifact.waitForFunction(() => document.hasFocus());
  const heard = keys.length;
  await page.keyboard.press("Space");
  await page.keyboard.press("x");
  // The page hears x's keyup only once its keydown has been acted on.
  await until(() => keys.slice(heard).includes("keyup x"), {
    what: `${engine}: the page to hear the keys pressed after the note`,
    timeoutMs: STEP_MS,
  });
  assert.deepEqual(
    await artifact.evaluate(() => ({
      field: document.getElementById("field").value,
      focus: document.activeElement.id || document.activeElement.tagName,
    })),
    { field: "", focus: "BODY" },
    `${engine}: keys pressed after a note made by mouse on a field`,
  );
}

/**
 * One fresh review per round: a page that calls focus() out of an open note takes the keyboard in
 * every engine, so the chrome unloads it there too; the reviewer's words land in the note, the page
 * is out until the note is done, and no key reaches the page.
 */
async function unloadRound(page, lab, engine, round) {
  await openFocusFixture(page, lab, `focus-${round}`);
  const keys = listenForKeys(page);
  await page.frameLocator("#artifact").frameLocator("#page").locator("#p1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.evaluate(() => {
    globalThis.moves = {};
    document.addEventListener(
      "focusout",
      (event) => {
        if (event.target.id === "cardText") globalThis.moves.out ??= performance.now();
      },
      true,
    );
    new globalThis.MutationObserver(() => {
      if (!document.getElementById("cover").hidden) globalThis.moves.shown ??= performance.now();
    }).observe(document.getElementById("cover"), { attributes: true, attributeFilter: ["hidden"] });
  });
  const artifact = page.frames().find((frame) => frame.url().includes("/artifact/"));
  await artifact.evaluate(() => (globalThis.calling = true));
  await page.keyboard.type("on");
  const unloaded = await page
    .waitForFunction(
      (line) =>
        !document.getElementById("cover").hidden &&
        document.getElementById("coverText").textContent === line,
      UNLOADED_LINE,
    )
    .then(
      () => true,
      () => false,
    );
  if (!unloaded) {
    const seen = await page.evaluate(() => ({
      focus: document.activeElement?.id,
      cover: document.getElementById("cover").hidden
        ? "hidden"
        : document.getElementById("coverText").textContent,
      frame: getComputedStyle(document.getElementById("artifact")).display,
    }));
    assert.fail(
      `${engine} round ${round}: the page took the focus from the note and was not unloaded; the focus is on #${seen.focus}, the cover is ${seen.cover}, the frame display is ${seen.frame}, and ${keys.length} key event(s) reached the page: ${keys.join("; ")}`,
    );
  }
  const probe = await keysSettle(keys, `${engine} round ${round}: the probe key reports to settle`);
  const ms = Math.round(await page.evaluate(() => globalThis.moves.shown - globalThis.moves.out));
  console.log(
    `${engine} round ${round}: probe key events reaching the page ${probe} of 4 (2 keys); move to unloaded ${ms} ms`,
  );
  await page.evaluate(() => (document.getElementById("cardText").value = ""));
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  const quiet = await keysSettle(keys, `${engine} round ${round}: the probe key reports to settle`);
  await page.keyboard.type("once");
  const text = await page.evaluate(() => document.getElementById("cardText").value);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("card").hidden && document.getElementById("cover").hidden,
  );
  await page.waitForFunction(() => document.querySelectorAll(".mark:not(.sent)").length === 1);
  assert.deepEqual(
    keys.slice(quiet),
    [],
    `${engine} round ${round}: the page received key events for the asserted word: ${keys.slice(quiet).join("; ")}`,
  );
  assert.equal(
    text,
    "once",
    `${engine} round ${round}: the note reads ${JSON.stringify(text)}, not the word typed`,
  );
  return { probe, ms };
}

/** A move of the focus from an open note to a chrome control leaves the page where it is. */
async function focusLeavesNoteAlone(page, lab, engine) {
  await openFocusFixture(page, lab, "leaves");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#p1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.evaluate(() => document.getElementById("annotate").focus());
  await page.waitForFunction(() => document.activeElement?.id === "annotate");
  // Two tasks: the check the focus move starts runs in one, so the second means it has run.
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0)));
  const state = await page.evaluate(() => ({
    card: !document.getElementById("card").hidden,
    cover: document.getElementById("cover").hidden,
    frame: getComputedStyle(document.getElementById("artifact")).display,
  }));
  assert.deepEqual(
    state,
    { card: true, cover: true, frame: "block" },
    `${engine}: a move of the focus from the note to a chrome control unloaded the page`,
  );
}

/**
 * A Markdown review in a tab that prefers `scheme`, read from what paints: the chrome's bar and the
 * page's own ground within a shade of that scheme's paper, and the pin the note draws in the page
 * resolving the same scheme's halo. The page under review hears the preference only through the
 * color-scheme the chrome and its wrapper frame declare.
 */
async function followsScheme(page, lab, scheme) {
  const dir = join(lab.dir, `scheme-${scheme}`);
  mkdirSync(dir);
  const file = join(dir, "plan.md");
  writeFileSync(file, "# Rollout plan\n\nShip the importer behind a flag.\n");
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  // Playwright's Firefox drops a context's colorScheme on a load answered with COOP same-origin, as
  // the chrome's is (measured: a plain page keeps it, the same page with the header does not); a
  // reviewer's own preference holds in every tab, so it is set again on the page.
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  const frame = page.frameLocator("#artifact").frameLocator("#page");
  await frame.locator("h1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  await page.keyboard.type(NOTE);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".mark:not(.sent)").length === 1);
  // The SDK's two hosts sit last in <html>, each resolving its sheet's :host roles.
  const halo = await frame
    .locator("html")
    .evaluate((html) => getComputedStyle(html.lastElementChild).getPropertyValue("--halo").trim());
  const spots = await page.evaluate(() => {
    const id = document.querySelector(".bar-id").getBoundingClientRect();
    const tools = document.querySelector(".bar-tools").getBoundingClientRect();
    const frame = document.getElementById("artifact").getBoundingClientRect();
    return {
      bar: [Math.round((id.right + tools.left) / 2), Math.round((id.top + id.bottom) / 2)],
      ground: [Math.round(frame.left + 24), Math.round(frame.top + 24)],
    };
  });
  const shot = decodePng(await page.screenshot());
  const paper = scheme === "light" ? [255, 255, 255] : [0, 0, 0];
  const seen = {
    bar: contrast(shot.pixel(...spots.bar), paper),
    ground: contrast(shot.pixel(...spots.ground), paper),
  };
  assert.ok(seen.bar < 1.25, `${scheme}: the chrome's bar is ${shot.pixel(...spots.bar)}`);
  assert.ok(seen.ground < 1.25, `${scheme}: the page's ground is ${shot.pixel(...spots.ground)}`);
  // The house's ink in light, its ground in dark (ROLES in src/browser/sdk.js).
  const want = scheme === "light" ? "oklch(0.21 0.012 260)" : "oklch(0.165 0.012 260)";
  assert.equal(halo, want, `${scheme}: the pin's halo`);
  return `${scheme} bar ${seen.bar.toFixed(2)}:1 and ground ${seen.ground.toFixed(2)}:1 from its paper`;
}

/**
 * The reviewer writes a note, sits idle 6.5 s, and presses Enter: the add is kept, and it rides a
 * connection the tab opened before the idle. Node closes an idle connection after 5 s by default,
 * and WebKit sent the add on one as it closed and lost it (docs/ENGINEERING-NOTES.md). The daemon
 * runs in this process, so the act can see which connection the add arrived on.
 */
async function addAfterAnIdle(page) {
  const lab = isolatedEnv();
  const daemon = await serve({ stateDir: lab.dir });
  const opened = new WeakMap();
  const adds = [];
  daemon.server.on("connection", (socket) => opened.set(socket, performance.now()));
  daemon.server.on("request", (req) => {
    if (req.method === "POST" && req.url.endsWith("/drafts")) adds.push(opened.get(req.socket));
  });
  try {
    const { session } = (await cli([fixture], lab.env)).json();
    await open(page, session.url);
    await page.waitForFunction(() => document.body.dataset.annotate === "1");
    await page.frameLocator("#artifact").frameLocator("#page").locator("#title").click();
    await page.waitForFunction(() => document.activeElement?.id === "cardText");
    await page.keyboard.insertText(NOTE);
    await page.evaluate(() => fetch("/health").then((res) => res.json()));
    const idleFrom = performance.now();
    // The idle is the case itself: past Node's default 5 s keep-alive close and its 1 s buffer.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.getElementById("card").hidden &&
        document.querySelectorAll(".mark:not(.sent)").length === 1,
    );
    assert.equal(adds.length, 1, "one add reached the daemon");
    assert.ok(
      adds[0] < idleFrom,
      `the add rode a connection opened ${Math.round(adds[0] - idleFrom)} ms after the idle began, so the server had closed the tab's idle ones`,
    );
  } finally {
    await daemon.close();
    rmSync(lab.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

/**
 * The chrome's code face is still loading when the browser goes offline, and fails: the review stays
 * on screen and says the browser is offline, never the browser's error page a reload would bring,
 * and back online the chrome reloads for the face. WebKit leaves a refused face `unloaded` and fires
 * no `loadingerror`, so there the chrome never learns of it and only the notice clears.
 */
async function faceRefusedOffline(page, lab, engine) {
  const held = [];
  await page.route("**/house/fonts/ibm-plex-mono/**", (route) =>
    held.length === 0 ? held.push(route) : route.continue(),
  );
  const { session } = (await cli([fixture], lab.env)).json();
  await open(page, session.url);
  await until(() => held.length === 1, { what: "the chrome's first code face to be held" });
  await page.context().setOffline(true);
  await held[0].abort("internetdisconnected");
  await page.waitForFunction(() =>
    /offline/.test(document.getElementById("noticeText").textContent),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      path: location.pathname.split("/")[1],
      file: document.getElementById("fileName").textContent,
      navigation: performance.getEntriesByType("navigation")[0].type,
    })),
    { path: "session", file: "plan.html", navigation: "navigate" },
  );
  await page.context().setOffline(false);
  await page.waitForFunction(
    (reload) =>
      (!reload || performance.getEntriesByType("navigation")[0]?.type === "reload") &&
      document.body?.dataset.ready === "1" &&
      document.getElementById("noticeText").textContent === "",
    engine !== "webkit",
  );
}

const requested = process.argv.slice(2);
const unknown = requested.filter((engine) => !(engine in ENGINES));
if (unknown.length) {
  console.error(`unknown engine ${unknown.join(", ")}; known: ${Object.keys(ENGINES).join(", ")}`);
  process.exit(2);
}
let failed = false;
for (const engine of requested.length ? requested : Object.keys(ENGINES)) {
  // One line per engine, always, which the workflow lifts into the job summary.
  const verdict = await smoke(engine).catch((error) => {
    failed = true;
    return `${error.named ?? engine} FAILED: ${error.stack ?? error}`;
  });
  console.log(`engine smoke: ${verdict}`);
}
process.exit(failed ? 1 : 0);
