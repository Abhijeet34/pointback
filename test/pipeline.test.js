import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

test("only GitHub Actions may create, move or delete a v* tag", () => {
  const ruleset = JSON.parse(read(".github/rulesets/tags.json"));
  assert.equal(ruleset.target, "tag");
  assert.deepEqual(ruleset.conditions.ref_name.include, ["refs/tags/v*"]);
  assert.deepEqual(
    ruleset.rules.map((rule) => rule.type).sort(),
    ["creation", "deletion", "update"],
    "a rule missing here is a tag a person can still move",
  );
  assert.deepEqual(
    ruleset.bypass_actors.map((actor) => actor.actor_type),
    ["Integration"],
  );
});

test("the tag namespace is bare v<version>, and the manifest agrees with package.json", () => {
  const config = JSON.parse(read("release-please-config.json"));
  assert.equal(config["include-component-in-tag"], false);
  assert.equal(JSON.parse(read(".release-please-manifest.json"))["."], pkg.version);
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
