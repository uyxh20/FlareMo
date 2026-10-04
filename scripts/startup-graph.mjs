/**
 * Worker startup analysis: static graph ranking + cold module evaluation.
 *
 * Both numbers matter for issue #138, and they answer different questions:
 *
 * 1. **Static-reachable graph, ranked by source bytes** (default). Walks
 *    *static* import edges only. A `wrangler` sourcemap lists a module
 *    whenever its code is present in the uploaded file, which stays true for a
 *    lazily-imported internal module and therefore cannot answer "does this run
 *    at isolate startup". The discriminator is `kind === "import-statement"`.
 *
 * 2. **Cold module evaluation** (`--cold`). The Worker ships as one bundled
 *    ESM file, and the isolate pays its parse + top-level execution on the
 *    first request. We bundle exactly what the deploy path would, then time
 *    `import()` of that file in a *fresh* process. Measuring the TS sources
 *    through a transform cache would measure the cache instead of the artifact.
 *
 * Sanity rule: any change to this script must be re-checked against packages
 * known to be on the graph (drizzle-orm, hono). A run that reports nothing at
 * all is broken, not a clean bill of health. `better-auth` is reported too but
 * is expected to read `NO` — it was moved out of the startup graph in #138.
 *
 * Usage:
 *   pnpm startup-graph                    # static graph ranking (default)
 *   pnpm startup-graph --pkg <name>       # filter the ranking to one package
 *   pnpm startup-graph --trace <package>  # who statically imports it
 *   pnpm startup-graph --cold             # also time cold module evaluation
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// esbuild is not a direct dependency of every workspace package, so resolve it
// through the root rather than hardcoding a pnpm store path that breaks on the
// next version bump.
const { build } = createRequire(import.meta.url)("esbuild");

const entry = "apps/worker/src/index.ts";
const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};
const only = argOf("pkg");
const trace = argOf("trace");
const withCold = process.argv.includes("--cold");

// One esbuild configuration serves both phases: the ranking reads `metafile`
// from an in-memory build, `--cold` writes the same graph to a file so a fresh
// Node process can import it. Divergent options would make the two numbers
// incomparable, which is the one thing this script must not do.
const shared = {
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["worker", "browser", "import", "default"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "node:*", "bufferutil", "utf-8-validate"],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
  tsconfig: "apps/worker/tsconfig.json",
};

const graphResult = await build({ ...shared, write: false, metafile: true });
const inputs = graphResult.metafile.inputs;
const seen = new Set();

(function walk(input) {
  if (seen.has(input)) return;
  seen.add(input);
  for (const edge of inputs[input]?.imports ?? []) {
    if (edge.kind !== "import-statement") continue;
    walk(edge.path);
  }
})(entry);

// Attribute each module to its owning package, then sum. pnpm store paths look
// like node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/... so the package name
// has to be taken from the segment after the final node_modules, not the store
// directory (which carries the version).
function packageOf(path) {
  if (path.startsWith("node_modules/.pnpm/")) {
    const tail = path.split("node_modules/").pop();
    return tail?.split("/")[0] ?? path;
  }
  if (path.startsWith("node_modules/")) {
    return path.split("node_modules/")[1]?.split("/")[0] ?? path;
  }
  if (path.startsWith("apps/") || path.startsWith("packages/")) {
    const parts = path.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  return "(entry)";
}

const byPackage = new Map();
let total = 0;
for (const input of seen) {
  let bytes = 0;
  try {
    bytes = statSync(input).size;
  } catch {
    continue;
  }
  total += bytes;
  const pkg = packageOf(input);
  const entryFor = byPackage.get(pkg) ?? { bytes: 0, files: 0 };
  entryFor.bytes += bytes;
  entryFor.files += 1;
  byPackage.set(pkg, entryFor);
}

const rows = [...byPackage.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const filter = (label, list) => {
  const filtered = only ? list.filter(([k]) => k.includes(only)) : list;
  console.log(`\n== ${label} (${filtered.length} packages) ==`);
  let sum = 0;
  for (const [pkg, { bytes, files }] of filtered.slice(0, 30)) {
    console.log(
      `${String(Math.round(bytes / 1024)).padStart(7)} KiB  ${String(files).padStart(4)} files  ${pkg}`,
    );
    sum += bytes;
  }
  console.log(
    `${String(Math.round(sum / 1024)).padStart(7)} KiB  total listed`,
  );
};

console.log(
  `static-reachable modules: ${seen.size}, total source: ${(total / 1024 / 1024).toFixed(2)} MiB`,
);
filter("by package", rows);

// Optional: report the direct static importers of a given package.
if (trace) {
  console.log(`\n== direct static importers of ${trace} ==`);
  for (const [input, meta] of Object.entries(inputs)) {
    for (const edge of meta.imports ?? []) {
      if (edge.kind !== "import-statement") continue;
      if (packageOf(edge.path) !== trace) continue;
      console.log(
        `  ${input}\n    -> ${edge.path}${edge.original ? `  [as ${edge.original}]` : ""}`,
      );
    }
  }
}
const onGraph = (pkg) => [...seen].some((s) => packageOf(s) === pkg);
console.log(
  `\nsanity: hono/drizzle-orm/better-auth on graph? ${[
    "hono",
    "drizzle-orm",
    "better-auth",
  ]
    .map((p) => `${p}=${onGraph(p) ? "yes" : "NO"}`)
    .join(" ")}`,
);

/**
 * Rewrite variable-specifier dynamic imports to literals.
 *
 * Better Auth's kysely adapter contains `const nodeSqlite = "node:sqlite";
 * await import(nodeSqlite)`. esbuild cannot resolve a specifier it only sees at
 * runtime, so it emits the call verbatim, and workerd's ESM validator rejects a
 * non-literal dynamic specifier at link time — even though the call sits in a
 * `try` and could only ever fail.
 *
 * The call has to become a *literal*: workerd rejects a non-literal specifier
 * regardless of what the variable holds, so repointing the variable is not
 * enough. A relative literal resolves inside workerd's own module registry; a
 * `node:`-prefixed one would need a module rule the glob matcher cannot match
 * because of the colon.
 */
function deVariableSpecifier(bundlePath) {
  const source = readFileSync(bundlePath, "utf8");
  const patched = source.replace(
    /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*nodeSqlite\s*\)/g,
    'import("./node-sqlite-stub.mjs")',
  );
  if (patched !== source) writeFileSync(bundlePath, patched);
  return patched !== source;
}

/**
 * Time `import()` of the bundle in a fresh process. The child is the only way
 * to get a genuinely cold module registry — importing in this process would be
 * warm by the time we got around to asking.
 */
function measureColdEval(bundlePath) {
  const probe = `
    const t0 = performance.now();
    await import(${JSON.stringify(bundlePath)});
    const t1 = performance.now();
    process.stdout.write(String(t1 - t0));
  `;
  const probePath = join(bundlePath, "..", "probe.mjs");
  writeFileSync(probePath, probe);
  // Three runs: the first pays any OS page-cache cost for the file itself.
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const out = execFileSync(process.execPath, [probePath], {
      encoding: "utf8",
    });
    samples.push(Number(out.trim()));
  }
  return { samples, best: Math.min(...samples) };
}

if (withCold) {
  const outDir = mkdtempSync(join(tmpdir(), "flaremo-startup-"));
  try {
    const bundlePath = join(outDir, "worker.mjs");
    const t0 = performance.now();
    await build({ ...shared, outfile: bundlePath });
    if (deVariableSpecifier(bundlePath)) {
      console.log(
        "\npatched: variable dynamic-import specifiers (see deVariableSpecifier)",
      );
    }
    console.log(`bundle: ${(performance.now() - t0).toFixed(0)} ms`);
    const cold = measureColdEval(bundlePath);
    console.log(
      `\ncold module evaluation (fresh process, 3 runs): ${cold.samples
        .map((s) => s.toFixed(1))
        .join(" / ")} ms  -> best ${cold.best.toFixed(1)} ms`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
