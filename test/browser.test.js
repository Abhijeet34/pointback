// The slice as a person does it: open the file, see it, annotate by mouse and by keyboard,
// send, and have a separate poll return the notes with their anchors. Runs in a real
// headless browser through DevTools; no browser means a loud skip, never a silent pass.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { envPrefix } from "../src/identity.js";
import { findBrowser, launchBrowser } from "./helpers/cdp.js";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";

const executable = findBrowser();
const lab = isolatedEnv();
let browser;
let opened;

before(async () => {
  if (!executable) return;
  opened = (await cli([fixture], lab.env)).json();
  browser = await launchBrowser(executable, { width: 800, height: 600 });
});
after(async () => {
  await browser?.close();
  await lab.stop();
});

test(
  "a reviewer annotates by mouse and by keyboard, sends, and the CLI returns it",
  { skip: !executable && `no browser found; set ${envPrefix}BROWSER` },
  async () => {
    const page = await browser.page(opened.session.url);
    const started = Date.now();
    await page.waitFor("document.body.dataset.ready === '1'");
    const readyMs = Date.now() - started;
    assert.ok(readyMs < 5000, `page usable after ${readyMs} ms`);
    assert.equal(await page.eval("document.getElementById('fileName').textContent"), "plan.html");

    await page.eval("document.getElementById('annotate').click()");
    assert.equal(
      await page.eval("document.getElementById('annotate').getAttribute('aria-checked')"),
      "true",
    );
    const rect = JSON.parse(
      await page.eval(
        "JSON.stringify(document.getElementById('artifact').getBoundingClientRect())",
      ),
    );
    await page.click(rect.left + 60, rect.top + 40);
    await page.type("Make the title shorter");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 1");

    // Keyboard only from here: into the frame, Tab twice, Enter opens the card, Enter adds the note.
    await page.eval("document.getElementById('artifact').focus()");
    await page.tab();
    await page.tab();
    await page.enter();
    await page.type("Keyboard note");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 2");
    assert.deepEqual(
      await page.eval(
        "[...document.querySelectorAll('.mark:not(.sent) .mark-tag')].map((e) => e.textContent)",
      ),
      ["h1", "table"],
    );
    assert.ok(
      await page.eval("document.getElementById('marks').getBoundingClientRect().height >= 72"),
      "notes stay visible at 800x600",
    );

    const polling = cli(["poll", fixture, "--timeout-ms", "10000"], lab.env);
    await new Promise((r) => setTimeout(r, 400));
    const sentAt = Date.now();
    await page.eval("document.getElementById('send').click()");
    const polled = (await polling).json();
    const roundTripMs = Date.now() - sentAt;
    assert.equal(polled.status, "feedback");
    assert.deepEqual(
      polled.prompts.map(({ uid, prompt, selector, tag }) => ({ uid, prompt, selector, tag })),
      [
        { uid: 1, prompt: "Make the title shorter", selector: "#title", tag: "h1" },
        { uid: 2, prompt: "Keyboard note", selector: "main > table", tag: "table" },
      ],
    );
    assert.equal(polled.prompts[0].text, "Rollout plan for the queue worker");
    assert.ok(roundTripMs < 5000, `send to poll return took ${roundTripMs} ms`);

    await page.waitFor(
      "document.querySelectorAll('.mark.sent').length === 2 && document.querySelectorAll('.mark:not(.sent)').length === 0",
    );
    await page.reload();
    await page.waitFor("document.body.dataset.ready === '1'");
    assert.equal(
      await page.eval("document.querySelectorAll('.mark.sent').length"),
      2,
      "sent notes survive a refresh",
    );
    console.log(
      `browser slice: page usable in ${readyMs} ms, send to poll return ${roundTripMs} ms`,
    );
  },
);

test(
  "a stale link tells the reviewer what to do instead of a blank page",
  { skip: !executable && "no browser found" },
  async () => {
    const page = await browser.page(opened.session.url.replace(/#.*$/, "#wrongtoken"));
    const text = await page.waitFor("document.getElementById('status').textContent");
    assert.match(text, /no longer works/);
  },
);
