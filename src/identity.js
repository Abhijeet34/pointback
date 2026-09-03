// The product name lives in package.json and nowhere else; everything named after it
// (binary, environment prefix, state directory) is derived here so a rename is one edit.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const name = pkg.name;
export const version = pkg.version;
export const envPrefix = `${name.toUpperCase().replaceAll("-", "_")}_`;
export const stateDirName = `.${name}`;

/** Reads `<PREFIX><key>` from the environment; undefined when unset or empty. */
export function env(key, environment = process.env) {
  const value = environment[`${envPrefix}${key}`];
  return value === undefined || value === "" ? undefined : value;
}
