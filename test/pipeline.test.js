import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { name } from "../src/identity.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const workflowNames = readdirSync(new URL(".github/workflows/", root));
const workflows = Object.fromEntries(
  workflowNames.map((file) => [file, read(`.github/workflows/${file}`)]),
);
const pkg = JSON.parse(read("package.json"));

// These files explain their own choices in comments, so a naive grep for a
// setting finds the sentence saying why it is absent.
const directives = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("a pull request runs Linux runners only", () => {
  // AGENTS.md, "CI runner platforms". ci.yml is the only workflow a pull
  // request starts, so the rule reduces to two questions.
  assert.doesNotMatch(workflows["ci.yml"], /runs-on:.*(macos|windows)/i);
  assert.ok(workflows["ci.yml"].includes("pull_request"));
  assert.doesNotMatch(workflows["cross-platform.yml"], /^\s*pull_request:/m);
  assert.match(workflows["cross-platform.yml"], /^\s*schedule:/m);
  assert.match(workflows["cross-platform.yml"], /^\s*workflow_dispatch:/m);
});

// A step that outlives its own budget fails the step, and the job reports a verdict a
// reader and the `checks` aggregate can both act on. A job that outlives timeout-minutes
// is reported `cancelled`, which carries no verdict at all: that is how run 33788793925
// spent twenty runner-minutes and told nobody what broke.
test("the step that runs the suite ends itself before its job's backstop does", () => {
  const steps = (text) => text.split(/\n {6}- /).slice(1);
  // A job under `jobs:` starts at a 2-space key; slicing there before matching
  // `timeout-minutes` keeps a sibling job's backstop from being read by mistake.
  const jobBlocks = (text) =>
    text.split(/(?=^ {2}[a-zA-Z_-]+:$)/m).filter((block) => /^ {2}[a-zA-Z_-]+:$/m.test(block));
  for (const file of ["ci.yml", "cross-platform.yml"]) {
    const job = jobBlocks(workflows[file]).find((block) => /npm run check/.test(block));
    assert.ok(job, `${file}: no job runs the suite`);
    const running = steps(job).filter((step) => /npm run check/.test(step));
    assert.equal(running.length, 1, `${file}: expected exactly one step to run the suite`);
    const step = Number(running[0].match(/timeout-minutes: (\d+)/)?.[1]);
    const jobTimeout = Number(job.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(step > 0, `${file}: the step that runs the suite carries no timeout-minutes`);
    assert.ok(
      step < jobTimeout,
      `${file}: the step's ${step} min budget must land inside the job's ${jobTimeout}`,
    );
  }
});

// The Windows runner checks out under git's core.autocrlf=true. Without this file every
// text file arrives CRLF and `prettier --check` refuses the whole tree - 61 of 61 files
// on run 33822348514, which is what reddened windows-2025 on the 0.1.0 release while
// Linux and macOS went green. Deleting the file reddens the release path again silently.
test("the checkout is LF on every platform, so the formatter sees one tree", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});

// A green tick does not say whether the only end-to-end coverage ran, and a release is
// gated on three platforms. Every workflow that runs the suite lifts the suite's own
// verdict line into its job summary, under `always()` so a leg that died before reaching
// the suite says that rather than nothing at all. AGENTS.md, "Working here".
test("every workflow that runs the suite says whether the browser case ran", () => {
  for (const file of ["ci.yml", "cross-platform.yml"]) {
    const text = workflows[file];
    assert.match(text, /npm run check 2>&1 \| tee "\$RUNNER_TEMP\/check\.log"/, file);
    assert.match(text, /name: Say whether the browser case ran\n\s+if: always\(\)/, file);
    assert.match(text, /grep -m1 '\^browser suite' "\$RUNNER_TEMP\/check\.log"/, file);
    assert.match(text, />> "\$GITHUB_STEP_SUMMARY"/, file);
  }
});

// One subject wore three faces before this: a path assumed on windows-2025, a launch nobody
// bounded on Linux, and a launch buried in dbus noise on Linux again. The resolution now
// lives in `KNOWN_BROWSERS` alone, and a workflow that types a path of its own puts it back
// to three - a runner image that moves Chrome would again be found out only by a red job.
test("no workflow types a browser path of its own", () => {
  for (const file of workflowNames) {
    assert.doesNotMatch(
      directives(workflows[file]),
      /google-chrome|chrome\.exe|Google Chrome/,
      file,
    );
  }
});

test("a leaked handle cannot turn a finished suite into a hung job", () => {
  // Measured on Node 24.11.1: `node --test --test-timeout=3000` over a file that leaks a
  // child process runs until something outside kills it, because a per-test timeout does
  // not close a handle; --test-force-exit ended the identical run in 0.13 s.
  assert.match(pkg.scripts.test, /--test-force-exit/);
  assert.match(pkg.scripts.test, /--test-timeout=\d+/);
});

test("the release and scheduled paths never cancel a run in flight", () => {
  for (const file of ["release.yml", "cross-platform.yml"]) {
    assert.doesNotMatch(directives(workflows[file]), /cancel-in-progress/, file);
  }
});

test("`checks` is the one required context and ci.yml is where it comes from", () => {
  const ruleset = JSON.parse(read(".github/rulesets/main.json"));
  const required = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  assert.deepEqual(required.parameters.required_status_checks, [{ context: "checks" }]);
  assert.match(workflows["ci.yml"], /^ {2}checks:$/m);
  // A skipped required check is not a failing one, so the aggregate has to run
  // whatever its dependencies did.
  assert.match(workflows["ci.yml"], /checks:\n\s+name: checks\n\s+if: always\(\)/);
});

test("main is protected against force-push, deletion and unsigned commits", () => {
  const types = JSON.parse(read(".github/rulesets/main.json")).rules.map((rule) => rule.type);
  for (const type of ["deletion", "non_fast_forward", "required_signatures", "pull_request"]) {
    assert.ok(types.includes(type), `main ruleset is missing ${type}`);
  }
  assert.deepEqual(JSON.parse(read(".github/rulesets/main.json")).bypass_actors, []);
});

test("nobody may move or delete a v* tag once it exists", () => {
  const ruleset = JSON.parse(read(".github/rulesets/tags.json"));
  assert.equal(ruleset.target, "tag");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepEqual(ruleset.rules.map((rule) => rule.type).sort(), ["deletion", "update"]);
  // No `creation`, and no bypass actors, and the two go together: GitHub
  // refuses an Integration bypass actor on a user-owned repository, and a
  // `creation` rule without one blocks release automation's own tag. Measured
  // both ways; docs/GIT-WORKFLOW.md, "What protects main", carries the 422s.
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.ok(!ruleset.rules.some((rule) => rule.type === "creation"));
});

test("the tag namespace is bare v<version>, and the manifest agrees with package.json", () => {
  const config = JSON.parse(read("release-please-config.json"));
  assert.equal(config["include-component-in-tag"], false);
  assert.equal(JSON.parse(read(".release-please-manifest.json"))["."], pkg.version);
});

// release-please writes CHANGELOG.md, the manifest and package.json in one
// commit, so the changelog existing is this tree saying the first release has
// been cut. Both assertions below only describe the window before that, and
// asserting them past it is what made every release pull request red: its own
// diff moves the manifest off "0.0.0", which is the thing that must not happen
// beforehand and the only thing that can happen afterwards.
const firstReleaseCut = existsSync(new URL("CHANGELOG.md", root));

test(
  "the first release is 0.1.0, not 1.0.0",
  { skip: firstReleaseCut && "the first release is cut; release-please owns the manifest now" },
  () => {
    // The two bump flags govern a bump from an existing version; the first
    // release is not a bump, and release-please answers it with a hardcoded
    // 1.0.0 unless `initial-version` says otherwise. docs/GIT-WORKFLOW.md,
    // "Versioning", carries the mechanism and the source it was read from.
    assert.equal(JSON.parse(read("release-please-config.json"))["initial-version"], "0.1.0");
    // Load-bearing sentinel, not a placeholder: release-please backfills a
    // synthetic previous release from any manifest entry that is not "0.0.0",
    // which would make the first release 0.1.1 and skip 0.1.0 entirely.
    assert.equal(JSON.parse(read(".release-please-manifest.json"))["."], "0.0.0");
  },
);

test("every repository setting that is not a file has a committed export", () => {
  // Files do not apply themselves; this is the one script that applies them.
  const script = read("scripts/apply-repo-settings.sh");
  for (const file of [
    ".github/rulesets/main.json",
    ".github/rulesets/tags.json",
    ".github/settings/repository.json",
    ".github/settings/actions-permissions.json",
    ".github/settings/actions-workflow-permissions.json",
    ".github/settings/actions-fork-pr-contributor-approval.json",
  ]) {
    JSON.parse(read(file)); // it must at least be the JSON the API is handed
    assert.ok(script.includes(file), `apply-repo-settings.sh never applies ${file}`);
  }
  // enabled is required alongside it; on its own the API answers 422.
  const permissions = JSON.parse(read(".github/settings/actions-permissions.json"));
  assert.equal(permissions.sha_pinning_required, true);
  assert.equal(permissions.enabled, true);
});

test("the setting that lets release-please open its pull request is a committed file", () => {
  // It lives only in a web UI otherwise, and the first release run failed on
  // exactly this: "GitHub Actions is not permitted to create or approve pull
  // requests".
  const settings = JSON.parse(read(".github/settings/actions-workflow-permissions.json"));
  assert.equal(settings.can_approve_pull_request_reviews, true);
  assert.equal(settings.default_workflow_permissions, "read");
});

test("the setting that parks the release pull request's CI is a committed file", () => {
  // Measured on run 33816315115: a `pull_request` run on release-please's own
  // branch completes as `action_required` with no check runs at all, because
  // GitHub classifies a github-actions[bot] pull request as an external
  // contribution even from a branch in this repository. No value of this policy
  // is known to exempt it, so the export is here to be diffable rather than to
  // be changed - docs/GIT-WORKFLOW.md, "Releasing", carries the approval step
  // that a release therefore needs.
  const approval = JSON.parse(read(".github/settings/actions-fork-pr-contributor-approval.json"));
  assert.equal(approval.approval_policy, "first_time_contributors");
});

test("publishing is off unless a repository variable says otherwise", () => {
  assert.match(workflows["release.yml"], /vars\.NPM_PUBLISH_ENABLED == 'true'/);
  // Trusted publishing generates provenance on its own; the explicit flag only
  // adds a way for the publish to fail. Asked of the command, not the file,
  // which explains the choice in a comment.
  const publish = workflows["release.yml"].match(/^ *run: npm publish .*$/m)[0];
  assert.equal(publish.trim(), "run: npm publish ./*.tgz --access public");
});

test("no release can attach to a tag that already existed", () => {
  assert.match(
    workflows["release.yml"],
    /release-preflight\.js --tag "\$TAG" --commit "\$RELEASE_SHA"/,
  );
  assert.match(workflows["release.yml"], /sha: \$\{\{ steps\.rp\.outputs\.sha \}\}/);
});

test("every action is pinned to a commit SHA", () => {
  for (const [file, text] of Object.entries(workflows)) {
    for (const [, ref] of text.matchAll(/^\s*(?:- )?uses: ([^\s]+)/gm)) {
      if (ref.startsWith("./")) continue; // a same-repo reusable workflow carries no ref
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref} is not pinned to a SHA`);
    }
  }
});

test("the secret scan reads the whole history against the canonical config", () => {
  const ci = workflows["ci.yml"];
  assert.match(ci, /fetch-depth: 0/);
  for (const pin of ["CONFIG_SHA256", "HOOK_SHA256", "GITLEAKS_SHA256"]) {
    assert.match(ci, new RegExp(`${pin}: "[0-9a-f]{64}"`), `${pin} is not pinned`);
  }
});

test("the synced gate matches the digests CI pins", () => {
  const ci = workflows["ci.yml"];
  const digest = (path) =>
    execFileSync("shasum", ["-a", "256", path], { cwd: root, encoding: "utf8" }).split(" ")[0];
  assert.match(ci, new RegExp(`CONFIG_SHA256: "${digest(".gitleaks.toml")}"`));
  assert.match(ci, new RegExp(`HOOK_SHA256: "${digest(".githooks/pre-push")}"`));
});

test("the product name is never written into delivery configuration", () => {
  // A rename must not have to reach into CI. src/identity.js derives everything
  // named after the product; these files derive it at run time instead.
  let hits = "";
  try {
    hits = execFileSync(
      "git",
      ["grep", "-l", "-i", name, "--", ".github", "release-please-config.json"],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.equal(hits, "", `name leaked into: ${hits}`);
});
