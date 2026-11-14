import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCheckArgs, touchedPackages } from "./pre-merge.mjs";

test("names each package a change touches, once", () => {
  assert.deepEqual(
    touchedPackages([
      "apps/web/src/planner/a.tsx",
      "apps/web/src/planner/b.tsx",
      "packages/domain/src/x.ts",
      "docs/fork-customizations.md",
      ".github/workflows/ci.yml",
    ]),
    ["@flaremo/domain", "@flaremo/web", "@flaremo/worker"],
  );
});

test("a web-only change typechecks only the web app", () => {
  assert.deepEqual(touchedPackages(["apps/web/src/a.tsx"]), ["@flaremo/web"]);
});

test("docs-only changes need no typecheck", () => {
  assert.deepEqual(touchedPackages(["AGENTS.md", "docs/a.md"]), []);
});

test("drops wrangler.jsonc from the format check only when it is absent", () => {
  const script = "biome ci AGENTS.md wrangler.jsonc docs";
  assert.deepEqual(formatCheckArgs(script, false), [
    "biome",
    "ci",
    "AGENTS.md",
    "docs",
  ]);
  assert.deepEqual(formatCheckArgs(script, true), [
    "biome",
    "ci",
    "AGENTS.md",
    "wrangler.jsonc",
    "docs",
  ]);
});
