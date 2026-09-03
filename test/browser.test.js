// The slice as a person does it: open the file, see it, annotate by mouse and by keyboard,
// send, and have a separate poll return the notes with their anchors. Runs in a real
// headless browser through DevTools; no browser means a loud skip, never a silent pass.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // Annotate mode is set by a message into the artifact's own event loop, so a
    // click dispatched before it lands is simply ignored. Measured on a loaded
    // machine: one full-suite run in three failed here before this wait existed.
    await page.waitFor("document.body.dataset.annotate === '1'");
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

    // The agent has the batch and has not answered: the reviewer sees that, with the clock running.
    await page.waitFor("document.getElementById('presence').dataset.state === 'working'");
    assert.match(
      await page.eval("document.getElementById('presenceText').textContent"),
      /^Working \d+:\d\d$/,
    );
    assert.equal(
      await page.eval("document.getElementById('send').textContent"),
      "Agent is working…",
    );
    assert.equal(await page.eval("document.getElementById('send').disabled"), true);

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

/**
 * A private copy of the fixture a test can save over, tall enough to scroll and ending in a
 * block deep enough that a click near the foot of the frame can only have landed in it.
 */
function copyOfFixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pb-live-"));
  const file = join(dir, "plan.html");
  copyFileSync(join(dirname(fixture), "plan.css"), join(dir, "plan.css"));
  const html = readFileSync(fixture, "utf8").replace(
    "</main>",
    `${"<p>filler</p>".repeat(60)}<style>#tail{display:block;min-height:200px;margin:0}</style>` +
      `<p id="tail">Bottom of the plan</p></main>`,
  );
  writeFileSync(file, html);
  return { file, html };
}

test(
  "a save reloads the open page, keeps the reviewer's place, and the notes follow the new text",
  { skip: !executable && "no browser found; set POINTBACK_BROWSER" },
  async () => {
    const { file, html } = copyOfFixture();
    const session = (await cli([file], lab.env)).json().session;
    const page = await browser.page(session.url);
    await page.waitFor("document.body.dataset.ready === '1'");
    assert.equal(await page.eval("document.body.dataset.revision"), "0");
    assert.equal(await page.eval("document.getElementById('presence').dataset.state"), "waiting");

    // Read to the bottom, then save: the page must come back at the bottom, not at the top.
    const rect = JSON.parse(
      await page.eval(
        "JSON.stringify(document.getElementById('artifact').getBoundingClientRect())",
      ),
    );
    await page.click(rect.left + 40, rect.top + rect.height - 34);
    await page.key("End", { keyCode: 35 });
    await new Promise((r) => setTimeout(r, 300));

    // Five saves in a row, timed from the write to the page being parsed, placed and annotatable.
    const latencies = [];
    for (let revision = 1; revision <= 5; revision += 1) {
      const savedAt = Date.now();
      // Each save differs in size as well as content, so no two look alike to the watcher.
      writeFileSync(
        file,
        html.replace("Bottom of the plan", "Bottom of the revised plan") + " ".repeat(revision),
      );
      await page.waitFor(`document.body.dataset.revision === '${revision}'`);
      latencies.push(Date.now() - savedAt);
    }
    const reloadMs = latencies.toSorted((a, b) => a - b)[2];
    assert.ok(Math.max(...latencies) < 3000, `reloads took ${latencies.join(", ")} ms`);

    await page.eval("document.getElementById('annotate').click()");
    await page.waitFor("document.body.dataset.annotate === '1'");
    await page.click(rect.left + 40, rect.top + rect.height - 34);
    await page.type("Cut this line");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 1");
    assert.equal(
      await page.eval("document.querySelector('.mark:not(.sent) .mark-text').textContent"),
      "Bottom of the revised plan",
      "the note lands on the saved text at the place the reviewer was reading",
    );

    // A second tab takes the review; the first says so at once rather than at the next save.
    const second = await browser.page(session.url);
    await second.waitFor("document.body.dataset.ready === '1'");
    const handover = await page.waitFor(
      "document.getElementById('notice').hidden ? '' : document.getElementById('noticeText').textContent",
    );
    assert.match(handover, /Another tab took over/);
    await page.eval("document.getElementById('takeOver').click()");
    await second.waitFor(
      "!document.getElementById('notice').hidden && document.getElementById('noticeText').textContent.includes('took over')",
    );
    await page.waitFor("document.getElementById('notice').hidden");
    await second.close();
    await page.front();

    // Ending with a note still queued offers to send it, and the agent gets it as the last batch.
    await page.eval("document.getElementById('end').click()");
    assert.equal(await page.eval("document.getElementById('endDialog').open"), true);
    assert.match(
      await page.eval("document.getElementById('endText').textContent"),
      /One note is still waiting/,
    );
    const polling = cli(["poll", file, "--timeout-ms", "10000"], lab.env);
    await new Promise((r) => setTimeout(r, 300));
    await page.eval("document.getElementById('endGo').click()");
    const polled = (await polling).json();
    assert.equal(polled.status, "feedback");
    assert.equal(polled.session_ended, true);
    assert.equal(polled.prompts[0].prompt, "Cut this line");
    assert.match(polled.next_step, /stop polling/);
    await page.waitFor(
      "document.getElementById('noticeText').textContent === 'You ended this review.'",
    );
    assert.equal(await page.eval("document.getElementById('annotate').disabled"), true);
    assert.equal(await page.eval("document.querySelectorAll('.mark:not(.sent)').length"), 0);
    console.log(
      `browser lifecycle: file save to reloaded page, five saves ${latencies.join("/")} ms, median ${reloadMs} ms`,
    );
  },
);
