#!/usr/bin/env node
// Fork: the quick checks to run before merging a branch into main. Seven of
// the ten red nightly runs between 18 Oct and 13 Nov were formatting or type
// errors that a few seconds of checking would have caught before the merge.
// Runs `pnpm format:check`, then the typecheck of each workspace package the
// branch touches (compared with origin/main). Exits non-zero on any failure.
// Usage: node scripts/fork/pre-merge.mjs [--base origin/main]
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRS = [
  ["apps/web/", "@flaremo/web"],
  ["apps/worker/", "@flaremo/worker"],
  ["apps/site/", "@flaremo/site"],
  ["apps/telegram-bot/", "@flaremo/telegram-bot-example"],
  ["packages/contracts/", "@flaremo/contracts"],
  ["packages/db/", "@flaremo/db"],
  ["packages/domain/", "@flaremo/domain"],
  ["packages/memos/", "@flaremo/memos"],
  ["plugins/", "@flaremo/plugins"],
];

// A shared package's types reach the packages that import it.
const DEPENDENTS = {
  "@flaremo/contracts": ["@flaremo/domain", "@flaremo/web", "@flaremo/worker"],
  "@flaremo/db": ["@flaremo/domain", "@flaremo/worker"],
  "@flaremo/domain": ["@flaremo/worker"],
};

/** The workspace packages to typecheck for a change to `files`. */
export function touchedPackages(files) {
  const names = new Set();
  for (const file of files) {
    for (const [dir, name] of PACKAGE_DIRS) {
      if (file.startsWith(dir)) names.add(name);
    }
  }
  for (const name of [...names]) {
    for (const dependent of DEPENDENTS[name] ?? []) names.add(dependent);
  }
  return [...names].sort();
}

function run(label, command, args) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  return result.status === 0;
}

function main(argv) {
  const baseFlag = argv.indexOf("--base");
  const base = baseFlag >= 0 ? argv[baseFlag + 1] : "origin/main";
  const files = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const packages = touchedPackages(files);
  const failed = [];
  if (!run("format check", "pnpm", ["format:check"])) failed.push("format");
  for (const name of packages) {
    if (!run(`typecheck ${name}`, "pnpm", ["--filter", name, "typecheck"])) {
      failed.push(name);
    }
  }
  console.log(
    failed.length === 0
      ? "\npre-merge: all checks passed"
      : `\npre-merge: FAILED (${failed.join(", ")})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
