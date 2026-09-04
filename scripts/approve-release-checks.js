// Releases the release pull request's parked checks, so that nothing about a
// release waits on a person to click.
//
// release-please opens that pull request with GITHUB_TOKEN, and GitHub creates
// the resulting `pull_request` run in an approval-required state: it completes
// as `action_required` having produced no check runs at all, so the required
// `checks` context never appears and the one pull request that carries a
// release was the one pull request in this repository that nothing checked.
// docs/GIT-WORKFLOW.md, "Releasing", carries the measurement.
//
// Node rather than a shell body calling `gh` and `jq`: the same code then runs
// on every platform the suite covers, and the test drives it with a request
// function instead of a stub binary on PATH.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOT = "github-actions[bot]";
const RELEASE_BRANCH_PREFIX = "release-please--";

/**
 * The one pull request this may ever act on, and every clause is a narrowing:
 * the author is the bot release-please runs as, the branch is one release-please
 * owns and lives in this repository rather than a fork, and the base is the
 * default branch. A pull request a person opened matches none of them.
 * @param {any[]} pulls
 * @param {string} repo owner/name, as GITHUB_REPOSITORY spells it
 */
export function releasePullRequest(pulls, repo) {
  return (
    pulls.find(
      (pr) =>
        pr?.user?.login === BOT &&
        typeof pr?.head?.ref === "string" &&
        pr.head.ref.startsWith(RELEASE_BRANCH_PREFIX) &&
        pr?.head?.repo?.full_name === repo &&
        pr?.base?.ref === pr?.base?.repo?.default_branch,
    ) ?? null
  );
}

/** @param {{workflow_runs?: any[]}} page */
export const parkedRuns = (page) =>
  (page?.workflow_runs ?? []).filter((run) => run.conclusion === "action_required");

/**
 * @param {object} input
 * @param {string} input.repo
 * @param {(method: string, path: string) => Promise<any>} input.request
 * @param {(ms: number) => Promise<void>} input.sleep
 * @param {number} [input.attempts]
 * @param {number} [input.intervalMs]
 * @param {(line: string) => void} [input.log]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function approveReleaseChecks({
  repo,
  request,
  sleep,
  attempts = 12,
  intervalMs = 10_000,
  log = console.log,
}) {
  const pulls = await request("GET", `repos/${repo}/pulls?state=open&per_page=100`);
  const pr = releasePullRequest(pulls ?? [], repo);
  if (!pr) return { ok: true, message: "no release pull request is open, nothing to approve" };

  const sha = pr.head.sha;
  const at = () =>
    request("GET", `repos/${repo}/actions/runs?event=pull_request&head_sha=${sha}&per_page=100`);
  const window = `${(attempts * intervalMs) / 1000}s`;

  // The head commit is seconds old when this runs, so its run may not exist yet.
  // Waiting for any run rather than for a parked one: a run already in flight
  // needs no approval and is the answer, not a reason to keep waiting.
  let page = await at();
  for (let attempt = 1; attempt < attempts && parkedRuns(page).length === 0; attempt += 1) {
    if ((page?.total_count ?? 0) > 0) break;
    await sleep(intervalMs);
    page = await at();
  }

  const parked = parkedRuns(page);
  if (parked.length === 0) {
    // The silent stall this exists to end: a pull request whose checks never
    // appeared reads exactly like one whose checks have not finished yet.
    if ((page?.total_count ?? 0) === 0) {
      return {
        ok: false,
        message: `#${pr.number} at ${sha} has no pull_request run at all after ${window}, so nothing will ever check it`,
      };
    }
    return { ok: true, message: `#${pr.number} at ${sha}: nothing is awaiting approval` };
  }

  for (const run of parked) {
    log(`approving run ${run.id} on #${pr.number}`);
    try {
      await request("POST", `repos/${repo}/actions/runs/${run.id}/approve`);
    } catch (error) {
      return {
        ok: false,
        message:
          `could not approve run ${run.id} on #${pr.number} (${error.message}); ` +
          "this job needs actions: write, and the release stays unchecked until it has it",
      };
    }
  }

  // Approving is a request and a 201 is not the outcome. The outcome is the run
  // leaving the parked state, which is what the `checks` context waits on.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (parkedRuns(await at()).length === 0) {
      return {
        ok: true,
        message: `#${pr.number} at ${sha} now faces the same gates as any other pull request`,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    message: `#${pr.number} at ${sha} is still awaiting approval ${window} after it was given`,
  };
}

// fileURLToPath, never URL.pathname: on Windows the latter is "/D:/...", which
// is how a guard like this silently stopped running (AGENTS.md, "Working here").
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      attempts: { type: "string" },
      "interval-ms": { type: "string" },
    },
  });
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must both be set");
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";

  const request = async (method, path) => {
    const response = await fetch(`${apiUrl}/${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${body}`);
    return body ? JSON.parse(body) : null;
  };

  const result = await approveReleaseChecks({
    repo,
    request,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    ...(values.attempts ? { attempts: Number(values.attempts) } : {}),
    ...(values["interval-ms"] ? { intervalMs: Number(values["interval-ms"]) } : {}),
  });
  if (!result.ok) console.error(`::error::${result.message}`);
  else console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
