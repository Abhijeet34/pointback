// The core act in the engines the CLI may hand a review to: it opens the reviewer's default
// browser, which is Safari on an unconfigured Mac, while test/browser.test.js drives Chromium
// only. Open a file, point at an element, write a note, send, and a poll returns it. Then the gate
// these engines need (docs/THREAT-MODEL.md): a page acting on the card's Enter gets nothing.
// `npm run smoke -- webkit firefox`; weekly in .github/workflows/cross-platform.yml.
// The chrome's CSP refuses string evaluation, so page-side waits are functions run in the tab.
/* global document, parent, nonce */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox, webkit } from "playwright-core";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";

const HOSTILE = new URL("./fixtures/hostile-after-gesture.html", import.meta.url);

const ENGINES = { webkit, firefox };
/** The longest any one Playwright wait may take; nothing in the act is slow, so a miss is a hang. */
const STEP_MS = 30_000;
const NOTE = "Make the title shorter";

async function smoke(engine) {
  const lab = isolatedEnv();
  let browser;
  try {
    browser = await ENGINES[engine].launch({ timeout: STEP_MS * 2 });
    const page = await browser.newPage();
    page.setDefaultTimeout(STEP_MS);
    const { session } = (await cli([fixture], lab.env)).json();
    await page.goto(session.url);
    await page.waitForFunction(() => document.body.dataset.ready === "1");
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
    await enterIsNotThePages(browser, lab);
    await readingPlace(browser, lab, engine);
    return `${engine} ${browser.version()} passed`;
  } finally {
    await browser?.close();
    await lab.stop();
  }
}

/**
 * Firefox and WebKit pass a key pressed in the chrome on to the page, so the page could spend the
 * reviewer's Enter in the card; the chrome hears nothing from the page for 5 s after a key there.
 */
async function enterIsNotThePages(browser, lab) {
  const dir = join(lab.dir, "review");
  mkdirSync(dir);
  const file = join(dir, "rollout.html");
  copyFileSync(HOSTILE, file);
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_MS);
  const { session } = (await cli([file], lab.env)).json();
  await page.goto(session.url);
  await page.waitForFunction(() => document.body.dataset.annotate === "1");
  await page.frameLocator("#artifact").frameLocator("#page").locator("#p1").click();
  await page.waitForFunction(() => document.activeElement?.id === "cardText");
  // The click is the reviewer's own gesture in the page, which the page may use; it is let lapse,
  // so all that is left to spend is the Enter. Inserted text presses no key.
  await page.waitForFunction(() => !navigator.userActivation.isActive);
  await page.keyboard.insertText(NOTE);
  await page.keyboard.press("Enter");
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

/**
 * A box that stays on screen, here a sticky header, crosses the top of the window wherever the
 * reviewer is; the reload must restore against the in-flow page, so a banner added above section 30
 * leaves its heading where the reviewer had it.
 */
async function readingPlace(browser, lab, engine) {
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
    const page = await browser.newPage();
    page.setDefaultTimeout(STEP_MS);
    const { session } = (await cli([file], lab.env)).json();
    await page.goto(session.url);
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
    return `${engine} FAILED: ${error.stack ?? error}`;
  });
  console.log(`engine smoke: ${verdict}`);
}
process.exit(failed ? 1 : 0);
