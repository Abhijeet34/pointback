// The core act in the engines the CLI may hand a review to: it opens the reviewer's default
// browser, which is Safari on an unconfigured Mac, while test/browser.test.js drives Chromium
// only. Open a file, point at an element, write a note, send, and a poll returns it. Then the gate
// these engines need (docs/THREAT-MODEL.md): a page acting on the card's Enter gets nothing.
// `npm run smoke -- webkit firefox`; weekly and on the release pull request in
// .github/workflows/cross-platform.yml.
// The chrome's CSP refuses string evaluation, so page-side waits are functions run in the tab.
/* global document, location, parent, nonce, getComputedStyle */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox, webkit } from "playwright-core";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";
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
    await act(browser, (page) => endKeepsTheCard(page, lab));
    await act(browser, (page) => readingPlace(page, lab, engine));
    await act(browser, (page) => pressOverThePage(page, lab));
    const control = await act(browser, (page) => keysReachThePage(page, lab, engine));
    const probes = [];
    const ms = [];
    for (let round = 1; round <= UNLOAD_ROUNDS; round += 1) {
      const result = await act(browser, (page) => unloadRound(page, lab, engine, round));
      probes.push(result.probe);
      ms.push(result.ms);
    }
    await act(browser, (page) => focusLeavesNoteAlone(page, lab, engine));
    return `${named} passed; unloaded in ${UNLOAD_ROUNDS} of ${UNLOAD_ROUNDS} rounds; probe keys reaching the page per round ${probes.join(", ")}; move to unloaded ms per round ${ms.join(", ")}; the key channel reported ${control} keys of the page's own`;
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
async function act(browser, fn) {
  const page = await browser.newPage();
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
        text: document.getElementById("cardText")?.value,
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
 * frame's load: on CI 5 of 75 Firefox runs on main timed out there while the chrome showed the
 * review, `ready` set, frames loaded and nothing pending; in the pages-closed variant tested just
 * before the change 4 of 80 did; after the change 0 of 320 failed on CI.
 */
async function open(page, url) {
  await page.evaluate((href) => setTimeout(() => location.assign(href)), url);
  await page.waitForFunction(() => document.body?.dataset.ready === "1");
}

/** Open a file, point at an element, write a note, send, and a poll returns it. */
async function coreAct(page, lab) {
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
}

/**
 * Firefox and WebKit pass a key pressed in the chrome on to the page, so the page could spend the
 * reviewer's Enter in the card; the chrome hears nothing from the page for 5 s after a key there.
 */
async function enterIsNotThePages(page, lab) {
  const dir = join(lab.dir, "review");
  mkdirSync(dir);
  const file = join(dir, "rollout.html");
  copyFileSync(HOSTILE, file);
  const { session } = (await cli([file], lab.env)).json();
  await open(page, session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#p1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  // The click is the reviewer's own gesture in the page, which the page may use; it is let lapse,
  // so all that is left to spend is the Enter. Inserted text presses no key.
  await page.waitForFunction(() => !navigator.userActivation.isActive);
  await page.keyboard.insertText(NOTE);
  await page.keyboard.press("Enter");
  // The chrome's own account that the Enter landed in the card: closed, the note kept unsent. A key
  // that went elsewhere fails here by name rather than as the page's silence below.
  await page.waitForFunction(
    () =>
      document.getElementById("card").hidden &&
      document.querySelectorAll(".mark:not(.sent)").length === 1,
  );
  const artifact = page.frames().find((frame) => frame.url().includes("/artifact/"));
  await artifact.waitForFunction(() => globalThis.log.length === 1);
  // Posted behind the page's own two messages through the same frames, so both were handled.
  await artifact.evaluate(() => parent.postMessage({ type: "scroll", nonce, y: -7 }, "*"));
  await page.waitForFunction(() => document.body.dataset.scroll === "-7");
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
        if (event.target.id === "cardText")
          moves.out ??= performance.now();
      },
      true,
    );
    new MutationObserver(() => {
      if (!document.getElementById("cover").hidden) moves.shown ??= performance.now();
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
  const ms = Math.round(await page.evaluate(() => moves.shown - moves.out));
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
