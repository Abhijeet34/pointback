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

test("the first release is 0.1.0, not 1.0.0", () => {
  // The two bump flags govern a bump from an existing version; the first
  // release is not a bump, and release-please answers it with a hardcoded
  // 1.0.0 unless `initial-version` says otherwise. docs/GIT-WORKFLOW.md,
  // "Versioning", carries the mechanism and the source it was read from.
  assert.equal(JSON.parse(read("release-please-config.json"))["initial-version"], "0.1.0");
  // Load-bearing sentinel, not a placeholder: release-please backfills a
  // synthetic previous release from any manifest entry that is not "0.0.0",
  // which would make the first release 0.1.1 and skip 0.1.0 entirely.
  assert.equal(JSON.parse(read(".release-please-manifest.json"))["."], "0.0.0");
});

test("the setting that lets release-please open its pull request is a committed file", () => {
  // It lives only in a web UI otherwise, and the first release run failed on
  // exactly this: "GitHub Actions is not permitted to create or approve pull
  // requests".
  const settings = JSON.parse(read(".github/settings/actions-workflow-permissions.json"));
  assert.equal(settings.can_approve_pull_request_reviews, true);
  assert.equal(settings.default_workflow_permissions, "read");
  assert.match(
    read("docs/GIT-WORKFLOW.md"),
    /--input \.github\/settings\/actions-workflow-permissions\.json/,
    "the day-one checklist must apply the file, not a retyped flag",
  );
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
