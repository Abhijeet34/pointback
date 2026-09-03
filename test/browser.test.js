// The slice as a person does it: open the file, see it, annotate an element, a passage and a
// table cell by mouse and by keyboard, send, and have a separate poll return every note with
// its anchor and an outline of the page. Runs in a real headless browser through DevTools;
// no browser means a loud skip, never a silent pass.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { envPrefix } from "../src/identity.js";
import { findBrowser, launchBrowser } from "./helpers/cdp.js";
import { cli, fixture, isolatedEnv } from "./helpers/env.js";

const executable = findBrowser();
const optedOut = process.env[`${envPrefix}BROWSER`] === "none";
// One line, always printed, saying which of the two happened. A suite that reports green
// over a case it never ran is worse than no case at all, so the skip has to be as loud as
// the run; CI reads this line back into the job summary.
console.log(
  executable
    ? `browser suite: running against ${executable}`
    : `browser suite: SKIPPED, no end-to-end coverage in this run (${envPrefix}BROWSER=none)`,
);

const lab = isolatedEnv();
let browser;
let opened;

// The skip above is opt-in. Finding no browser and saying nothing is the failure this
// guards: without it a runner that lost its Chrome reports a clean suite.
test("the browser suite has a browser to run against", () => {
  assert.ok(
    executable || optedOut,
    `no browser found. Install Chrome or set ${envPrefix}BROWSER to its path, or to "none" to opt out of the only end-to-end coverage this repository has.`,
  );
});

before(async () => {
  if (!executable) return;
  opened = (await cli([fixture], lab.env)).json();
  browser = await launchBrowser(executable, { width: 800, height: 600 });
});
after(async () => {
  await browser?.close();
  await lab.stop();
});

/** The reference implementation's snapshot: every element to depth 6 with 80 characters of text. */
const REFERENCE_SNAPSHOT = `(() => {
  const lines = [];
  const walk = (element, depth) => {
    if (!(element instanceof Element) || depth > 6) return;
    const text = (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ");
    const name = text ? ' "' + text.slice(0, 80).replace(/"/g, "'") + '"' : "";
    lines.push("  ".repeat(depth) + "uid=" + lines.length + " " + element.tagName.toLowerCase() + name);
    for (const child of element.children) walk(child, depth + 1);
  };
  walk(document.body, 0);
  return new TextEncoder().encode(lines.join("\\n")).length;
})()`;

test(
  "a reviewer annotates an element, a passage and a cell, by mouse and by keyboard",
  { skip: !executable && `no browser found; set ${envPrefix}BROWSER` },
  async () => {
    const page = await browser.page(opened.session.url);
    const started = Date.now();
    const attaching = page.frame();
    await page.waitFor("document.body.dataset.ready === '1'");
    const readyMs = Date.now() - started;
    const artifact = await attaching;
    assert.ok(readyMs < 5000, `page usable after ${readyMs} ms`);
    // The chrome is ready as soon as the SDK announces itself, which is earlier than the
    // artifact having laid its stylesheet out; the rects below are measured from it.
    await artifact.waitFor("document.readyState === 'complete'");
    assert.equal(await page.eval("document.getElementById('fileName').textContent"), "plan.html");

    const frameBox = JSON.parse(
      await page.eval(
        "JSON.stringify(document.getElementById('artifact').getBoundingClientRect())",
      ),
    );
    const boxOf = async (expression) =>
      JSON.parse(await artifact.eval(`JSON.stringify((${expression}).getBoundingClientRect())`));
    const pointOf = async (selector) => {
      const r = await boxOf(`document.querySelector(${JSON.stringify(selector)})`);
      return {
        x: frameBox.left + r.left + Math.min(30, r.width / 2),
        y: frameBox.top + r.top + r.height / 2,
      };
    };
    // "Move the queue" is characters 0 to 14 of #p1; a range gives its pixels exactly.
    const line = await boxOf(
      "(() => { const r = document.createRange(); r.setStart(document.getElementById('p1').firstChild, 0); r.setEnd(document.getElementById('p1').firstChild, 14); return r; })()",
    );
    const passage = {
      from: { x: frameBox.left + line.left + 1, y: frameBox.top + line.top + line.height / 2 },
      to: { x: frameBox.left + line.right - 1, y: frameBox.top + line.top + line.height / 2 },
    };

    // The reference's own text-range row was recorded NOT EXERCISED because a synthetic drag
    // might not select anything. With annotate off nothing of ours can touch the selection,
    // so this settles it before the passage tests lean on it.
    await page.pointerInto(artifact, passage.from);
    await page.drag(passage.from, passage.to);
    assert.equal(
      await artifact.eval("getSelection().toString()"),
      "Move the queue",
      "a dispatched press-move-release makes a real DOM selection",
    );
    const referenceBytes = await artifact.eval(REFERENCE_SNAPSHOT);

    await page.eval("document.getElementById('annotate').click()");
    assert.equal(
      await page.eval("document.getElementById('annotate').getAttribute('aria-checked')"),
      "true",
    );
    // Annotate mode is set by a message into the artifact's own event loop, so a
    // click dispatched before it lands is simply ignored. Measured on a loaded
    // machine: one full-suite run in three failed here before this wait existed.
    await page.waitFor("document.body.dataset.annotate === '1'");

    const title = await pointOf("#title");
    await page.click(title.x, title.y);
    await page.type("Make the title shorter");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 1");

    // A passage by mouse, timed inside the artifact: the probe is registered after the SDK,
    // so it runs once the card is open, and the event's own timeStamp is the drag's end.
    // The card focuses its textarea, which from the document's side is the SDK's own host
    // element: that is how a probe with no way into a closed shadow root sees it open.
    // Each probe shares the SDK listener's phase and is registered after it, so it runs
    // once the card is up; a capture-phase probe on a bubble-phase listener times nothing.
    await artifact.eval(
      `(document.addEventListener("mouseup", (event) => {
        globalThis.mouseCardMs = performance.now() - event.timeStamp;
        globalThis.mouseCardOpen = document.activeElement === document.documentElement.lastElementChild;
      }, true), 1)`,
    );
    await page.drag(passage.from, passage.to);
    const mouseCardMs = await artifact.eval("globalThis.mouseCardMs");
    assert.equal(await artifact.eval("globalThis.mouseCardOpen"), true, "the drag opened a card");
    await page.type("Name the queue in the first sentence");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 2");

    // Keyboard only from here. Focus is on #p1, which the card returned it to.
    await page.key("Escape", { keyCode: 27 });
    await artifact.eval(
      `(document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || globalThis.keyCardMs !== undefined) return;
        globalThis.keyCardMs = performance.now() - event.timeStamp;
        globalThis.keyCardOpen = document.activeElement === document.documentElement.lastElementChild;
      }), 1)`,
    );
    for (let word = 0; word < 5; word += 1) await page.shiftArrow("right");
    assert.equal(
      await artifact.eval("getSelection().toString().trim()"),
      "Move the queue worker from",
      "Shift+ArrowRight grows a real selection word by word",
    );
    await page.enter();
    const keyCardMs = await artifact.eval("globalThis.keyCardMs");
    assert.equal(await artifact.eval("globalThis.keyCardOpen"), true, "Enter opened a card");
    await page.type("Say which queue");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 3");

    // Eight more stops reach the owner of the first step: table, header row, its three
    // cells, the first body row, and its first two cells.
    for (let stop = 0; stop < 8; stop += 1) await page.tab();
    await page.enter();
    await page.type("Priya is on leave that week");
    await page.enter();
    await page.waitFor("document.querySelectorAll('.mark:not(.sent)').length === 4");

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
        {
          uid: 2,
          prompt: "Name the queue in the first sentence",
          selector: "#p1",
          tag: "text",
        },
        { uid: 3, prompt: "Say which queue", selector: "#p1", tag: "text" },
        {
          uid: 4,
          prompt: "Priya is on leave that week",
          selector: "main > table > tbody > tr:nth-of-type(1) > td:nth-of-type(2)",
          tag: "td",
        },
      ],
    );
    assert.equal(polled.prompts[0].text, "Rollout plan for the queue worker");
    assert.equal(polled.prompts[1].text, "Move the queue");
    assert.equal(polled.prompts[1].target.start, 0);
    assert.equal(polled.prompts[1].target.end, 14);

    const keyboard = polled.prompts[2];
    assert.equal(keyboard.text, "Move the queue worker from");
    assert.deepEqual(keyboard.target, {
      type: "text-range",
      start: 0,
      end: 26,
      before: "",
      after: " cron to a long-running process ",
    });
    assert.equal(polled.prompts[3].text, "Priya");
    assert.deepEqual(polled.prompts[3].target, {
      type: "table-cell",
      row: "Shadow traffic",
      column: "Owner",
    });

    assert.match(polled.structure, /#title "Rollout plan for the queue worker"/);
    assert.match(polled.structure, /table "Step \| Owner \| Weeks"/);
    assert.match(polled.structure, /ul "3 items"/);
    assert.doesNotMatch(polled.structure, /Draft notes/, "a hidden container is never outlined");
    const structureBytes = Buffer.byteLength(polled.structure);
    assert.ok(
      structureBytes * 4 < referenceBytes,
      `structure is ${structureBytes} B against the reference format's ${referenceBytes} B`,
    );

    // The anchor's job: find the passage again in a page the agent has re-rendered.
    const found = await artifact.eval(`(() => {
      const p = document.getElementById("p1");
      p.innerHTML = "Move the <em>queue worker</em> from cron to a long-running process in three steps.";
      const squash = (text) => text.replace(/\\s+/g, " ");
      const whole = p.textContent;
      const anchor = ${JSON.stringify(keyboard.target)};
      return {
        text: squash(whole.slice(anchor.start, anchor.end)),
        before: squash(whole.slice(Math.max(0, anchor.start - 32), anchor.start)),
        after: squash(whole.slice(anchor.end, anchor.end + 32)),
        occurrences: squash(whole).split(anchor.before + squash(whole.slice(anchor.start, anchor.end)) + anchor.after).length - 1,
      };
    })()`);
    assert.deepEqual(found, {
      text: keyboard.text,
      before: keyboard.target.before,
      after: keyboard.target.after,
      occurrences: 1,
    });

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
      "document.querySelectorAll('.mark.sent').length === 4 && document.querySelectorAll('.mark:not(.sent)').length === 0",
    );
    assert.deepEqual(
      await page.eval(
        "[...document.querySelectorAll('.mark.sent .mark-tag')].map((e) => e.textContent)",
      ),
      ["h1", "text", "text", "td"],
    );
    assert.deepEqual(
      await page.eval(
        "[...document.querySelectorAll('.mark.sent .mark-text')].map((e) => e.textContent)",
      ),
      [
        "Rollout plan for the queue worker",
        "“Move the queue”",
        "“Move the queue worker from”",
        "Priya · Shadow traffic › Owner",
      ],
    );
    assert.ok(roundTripMs < 5000, `send to poll return took ${roundTripMs} ms`);

    await page.reload();
    await page.waitFor("document.body.dataset.ready === '1'");
    assert.equal(
      await page.eval("document.querySelectorAll('.mark.sent').length"),
      4,
      "sent notes survive a refresh",
    );
    console.log(
      `browser slice: page usable in ${readyMs} ms; selection to card ${mouseCardMs.toFixed(1)} ms by mouse, ` +
        `${keyCardMs.toFixed(1)} ms by keyboard; send to poll return ${roundTripMs} ms; ` +
        `page structure ${structureBytes} B against ${referenceBytes} B in the reference's format`,
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
    // The reviewer reads to the bottom, driven through the artifact's own session. Synthetic
    // input is the wrong instrument here: a key goes to whichever frame holds focus, and a
    // wheel goes to the frame under the point only once the browser holds that out-of-process
    // frame's hit-test region - measured, a wheel re-sent for ten seconds still left scrollY
    // at 0 about once in forty runs, and the fixed pause this replaces left the page at the
    // top often enough to fail in CI, anchoring the note to whatever the foot of the frame
    // happened to show. Clicking and typing into the frame stays covered by the annotation
    // test above; this one is about the page coming back where the reviewer was.
    const artifact = await page.frame();
    await artifact.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
    // Then wait for that place to reach the chrome, which is what a reload restores from.
    await page.waitFor("Number(document.body.dataset.scroll) > 0");

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
