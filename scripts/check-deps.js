// Dependency direction for src/: a module may import only from a lower layer. Layers are
// listed low to high; an import within the same layer or upward fails, as does any cycle.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const LAYERS = [
  ["identity.js", "limits.js"],
  ["state-dir.js", "http-guard.js", "artifact-path.js", "inject.js", "watch.js"],
  ["session-store.js", "events.js"],
  ["server.js", "client.js"],
  ["cli.js"],
];

export function checkTree(srcDir, layers = LAYERS) {
  const layerOf = new Map(layers.flatMap((names, index) => names.map((name) => [name, index])));
  const graph = new Map();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(join(srcDir, file), "utf8");
    const imports = [...source.matchAll(/^import\b[^"']*["'](\.\/[^"']+)["']/gm)].map((m) =>
      basename(m[1]),
    );
    graph.set(file, imports);
  }
  const problems = [];
  for (const [file, imports] of graph) {
    if (!layerOf.has(file)) problems.push(`${file} is not assigned to a layer`);
    for (const dep of imports) {
      if (layerOf.has(file) && layerOf.has(dep) && layerOf.get(dep) >= layerOf.get(file)) {
        problems.push(`${file} imports ${dep}, which is not in a lower layer`);
      }
    }
  }
  problems.push(...cycles(graph).map((cycle) => `cycle: ${cycle.join(" -> ")}`));
  return problems;
}

function cycles(graph) {
  const found = [];
  const state = new Map();
  const walk = (node, path) => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "active") {
      found.push([...path.slice(path.indexOf(node)), node]);
      return;
    }
    state.set(node, "active");
    for (const dep of graph.get(node) ?? []) walk(dep, [...path, node]);
    state.set(node, "done");
  };
  for (const node of graph.keys()) walk(node, []);
  return found;
}

if (resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const problems = checkTree(new URL("../src/", import.meta.url).pathname);
  for (const problem of problems) console.error(problem);
  console.log(
    problems.length === 0
      ? "dependency direction: ok"
      : `dependency direction: ${problems.length} problem(s)`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}
