import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveReleaseChecks,
  parkedRuns,
  releasePullRequest,
} from "../scripts/approve-release-checks.js";

const REPO = "owner/name";
const SHA = "a".repeat(40);

const releasePr = {
  number: 10,
  user: { login: "github-actions[bot]" },
  head: {
    ref: "release-please--branches--main--components--x",
    sha: SHA,
    repo: { full_name: REPO },
  },
  base: { ref: "main", repo: { default_branch: "main" } },
};

const parked = { total_count: 1, workflow_runs: [{ id: 33849288493, conclusion: "action_required" }] };
const running = { total_count: 1, workflow_runs: [{ id: 33849288493, conclusion: null }] };
const none = { total_count: 0, workflow_runs: [] };

/**
 * A recording GitHub. `runs` is consumed one page per read, and the last one
 * repeats, so a test says what the run looks like before and after the approval.
 */
function github({ pulls = [releasePr], runs = [parked, running], approve = () => null } = {}) {
  const calls = [];
  const pages = [...runs];
  return {
    calls,
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path.includes("/pulls?")) return pulls;
      if (path.endsWith("/approve")) return approve(path);
      return pages.length > 1 ? pages.shift() : pages[0];
    },
  };
}

const run = (gh, overrides = {}) =>
  approveReleaseChecks({
    repo: REPO,
    request: gh.request,
    sleep: async () => {},
    attempts: 2,
    intervalMs: 0,
    log: () => {},
    ...overrides,
  });

test("the release pull request is approved, and the approval is confirmed to have taken", async () => {
  const gh = github();
  const result = await run(gh);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /now faces the same gates as any other pull request/);
  assert.ok(
    gh.calls.includes(`POST repos/${REPO}/actions/runs/33849288493/approve`),
    gh.calls.join("\n"),
  );
});

// The whole security property. Approving is a privilege, and the only pull
// request it may ever reach is the one release-please opens: the four clauses
// below are the four ways another pull request could try to look like it.
test("no pull request but release-please's own is ever selected", () => {
  const impostors = {
    "a person's own branch": { ...releasePr, user: { login: "someone" } },
    "a branch release-please does not own": {
      ...releasePr,
      head: { ...releasePr.head, ref: "fix/looks-innocent" },
    },
    "a fork": {
      ...releasePr,
      head: { ...releasePr.head, repo: { full_name: "attacker/name" } },
    },
    "a base that is not the default branch": {
      ...releasePr,
      base: { ref: "release/1.x", repo: { default_branch: "main" } },
    },
  };
  for (const [what, pr] of Object.entries(impostors)) {
    assert.equal(releasePullRequest([pr], REPO), null, what);
  }
  assert.equal(releasePullRequest([...Object.values(impostors), releasePr], REPO), releasePr);
});

test("an impostor pull request leaves the job doing nothing at all", async () => {
  const gh = github({ pulls: [{ ...releasePr, user: { login: "someone" } }] });
  const result = await run(gh);
  assert.equal(result.ok, true);
  assert.match(result.message, /no release pull request is open/);
  assert.deepEqual(gh.calls, [`GET repos/${REPO}/pulls?state=open&per_page=100`]);
});

// The failure this replaces is a release that stalls silently, so a head commit
// that never grew a run has to be louder than one whose run is already going.
test("a head commit with no run at all fails the job", async () => {
  const result = await run(github({ runs: [none] }));
  assert.equal(result.ok, false);
  assert.match(result.message, /has no pull_request run at all after 0s/);
});

test("a run already in flight needs no approval and is not one", async () => {
  const gh = github({ runs: [running] });
  const result = await run(gh);
  assert.equal(result.ok, true);
  assert.match(result.message, /nothing is awaiting approval/);
  assert.ok(!gh.calls.some((call) => call.startsWith("POST")), gh.calls.join("\n"));
});

// A GITHUB_TOKEN that cannot approve is the one unknown this design carries, so
// it fails the job naming the permission rather than leaving the release unchecked.
test("a refused approval fails the job and names the permission it needs", async () => {
  const result = await run(
    github({
      approve: () => {
        throw new Error("POST answered 403");
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /403/);
  assert.match(result.message, /needs actions: write/);
});

test("a run that stays parked after being approved fails the job", async () => {
  const result = await run(github({ runs: [parked] }));
  assert.equal(result.ok, false);
  assert.match(result.message, /still awaiting approval/);
});

test("only action_required is treated as parked", () => {
  assert.deepEqual(parkedRuns(none), []);
  assert.deepEqual(parkedRuns(running), []);
  assert.equal(parkedRuns(parked).length, 1);
  assert.deepEqual(parkedRuns(undefined), []);
});
