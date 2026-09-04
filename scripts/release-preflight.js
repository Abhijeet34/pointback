// Refuses a release that is about to attach to the wrong tree, before anything
// is uploaded or published. The failure this exists for was measured on a
// sibling repository: the tag already existed from an unrelated line of
// history, GitHub reused it without complaining, and the release pointed at a
// commit nobody had reviewed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {object} input
 * @param {string} input.tag the tag release-please created
 * @param {string} input.tagCommit the commit that tag resolves to
 * @param {string} input.releaseCommit the commit release-please reported releasing
 * @param {{version: string, private?: boolean, license?: string, files?: string[], repository?: unknown}} input.pkg
 * @param {boolean} input.publishing whether a tarball is about to leave the machine
 * @returns {string[]} one line per problem; empty means the release may proceed
 */
export function preflight({ tag, tagCommit, releaseCommit, pkg, publishing }) {
  const problems = [];
  if (tag !== `v${pkg.version}`) {
    problems.push(`tag ${tag} does not name package.json's version ${pkg.version}`);
  }
  // The whole point: release-please creates v<version> and reports the commit it
  // released. A tag that predates this run points somewhere else, and only this
  // comparison can tell the two apart after the fact.
  if (tagCommit !== releaseCommit) {
    problems.push(
      `tag ${tag} points at ${tagCommit}, not at the released commit ${releaseCommit}; ` +
        "it existed before this run and must be deleted rather than reused",
    );
  }
  if (publishing) {
    if (pkg.private === true)
      problems.push('package.json is "private": true, so it cannot publish');
    if (!pkg.license || pkg.license === "UNLICENSED") {
      problems.push(
        `package.json license is ${pkg.license ?? "absent"}, which npm will not publish`,
      );
    }
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
      problems.push(
        "package.json has no files allowlist, so the tarball would carry the whole tree",
      );
    }
    // Trusted publishing generates provenance on its own, and npm's
    // provenance prerequisites require "a public `repository` that matches
    // (case-sensitive) where you are publishing with provenance from". Without
    // the field the publish fails at the registry, after the tag and the
    // release already exist, which is the most expensive place to find out.
    const repository =
      typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
    if (!/^(git\+)?https:\/\/github\.com\//.test(repository)) {
      problems.push(
        `package.json repository is ${repository || "absent"}, so npm cannot generate the ` +
          "provenance that trusted publishing publishes by default",
      );
    }
  }
  return problems;
}

// fileURLToPath, never URL.pathname: on Windows the latter is "/D:/...", so this guard was
// false and the release gate exited 0 without comparing anything.
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      commit: { type: "string" },
      publishing: { type: "boolean", default: false },
    },
  });
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // `<tag>^{}` dereferences an annotated tag to its commit; a lightweight tag
  // answers the same thing, so one form covers both.
  const tagCommit = execFileSync("git", ["rev-parse", `${values.tag}^{}`], {
    encoding: "utf8",
  }).trim();
  const problems = preflight({
    tag: values.tag,
    tagCommit,
    releaseCommit: values.commit,
    pkg,
    publishing: values.publishing,
  });
  for (const problem of problems) console.error(problem);
  console.log(
    problems.length === 0
      ? `release preflight: ok, ${values.tag} is ${tagCommit}`
      : `release preflight: ${problems.length} problem(s)`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}
