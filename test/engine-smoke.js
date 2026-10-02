// The core act in the engines the CLI may hand a review to: it opens the reviewer's default
// browser, which is Safari on an unconfigured Mac, while test/browser.test.js drives Chromium
// only. Open a file, point at an element, write a note, send, and a poll returns it.
// `npm run smoke -- webkit firefox`; weekly in .github/workflows/cross-platform.yml.
// The chrome's CSP refuses string evaluation, so page-side waits are functions run in the tab.
/* global document */
import assert from "node:assert/strict";
import { firefox, webkit } from "playwright-core";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";

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
    await page.click("#annotate");
    await page.waitForFunction(() => document.body.dataset.annotate === "1");
    await page.frameLocator("#artifact").locator("#title").click();
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
    return `${engine} ${browser.version()} passed`;
  } finally {
    await browser?.close();
    await lab.stop();
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
