/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The planner (cockpit, goals, weekly review) only works while each upstream
// file still carries its small hook-in. A merge can drop one cleanly and nothing
// else fails: a hard reload of /cockpit then 404s, an offline visit is cached as
// public, or the sidebar link is gone. This test fails loudly instead. The list
// of hook-ins is in docs/fork-customizations.md; the nightly archive sync and
// the /api/app/planner mount are covered by packages/domain/src/fork/guards.test.ts.

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const PAGES = ["cockpit", "goals", "weekly-review", "period-review"] as const;

const hookIns: Array<{ file: string; path: string; mustContain: RegExp[] }> = [
  {
    file: "apps/web/src/router-tree.tsx",
    path: "../router-tree.tsx",
    mustContain: [
      /import \{ plannerRoutes \} from "@\/planner\/routes"/,
      /^\s*\.\.\.plannerRoutes,/m,
    ],
  },
  {
    file: "apps/web/src/components/flaremo-explorer.tsx",
    path: "../components/flaremo-explorer.tsx",
    mustContain: [
      /import \{ PlannerNavLink \} from "@\/planner\/nav-link"/,
      /<PlannerNavLink onNavigate=\{onNavigate\} \/>/,
    ],
  },
  {
    file: "apps/web/public/sw.js",
    path: "../../public/sw.js",
    mustContain: PAGES.map((page) => new RegExp(`\\$\\{scopePath\\}${page}\``)),
  },
  {
    file: "apps/worker/src/spa-routes.ts",
    path: "../../../worker/src/spa-routes.ts",
    mustContain: PAGES.map((page) => new RegExp(`"/${page}",`)),
  },
  {
    file: "packages/contracts/src/index.ts",
    path: "../../../../packages/contracts/src/index.ts",
    mustContain: [/export \* from "\.\/planner";/],
  },
  {
    file: "playwright.config.ts",
    path: "../../../../playwright.config.ts",
    mustContain: [/\|cockpit\|fork-ui\|goals-review\)\\\.spec\\\.ts/],
  },
];

describe("the planner's hook-ins in upstream files", () => {
  for (const hook of hookIns) {
    it(`${hook.file} still carries its hook-in`, () => {
      const text = read(hook.path);
      for (const pattern of hook.mustContain) {
        expect(text, `${hook.file} should match ${pattern}`).toMatch(pattern);
      }
    });
  }

  it("routes.tsx registers exactly the four planner pages", () => {
    const text = read("./routes.tsx");
    for (const page of PAGES) {
      expect(text).toContain(`path: "/${page}",`);
    }
    expect(text).toMatch(
      /plannerRoutes = \[\s*cockpitRoute,\s*goalsRoute,\s*weeklyReviewRoute,\s*periodReviewRoute,?\s*\] as const/,
    );
  });
});
