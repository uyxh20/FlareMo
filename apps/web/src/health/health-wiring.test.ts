/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The health tracker only works while each upstream file still carries its small
// hook-in. After an upstream sync that rewrites one of them, this fails loudly
// instead of the tracker quietly going dark (labels gone, strip gone, link gone,
// every new note unread). The list of hook-ins is in docs/fork-customizations.md.

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const hookIns: Array<{ file: string; path: string; mustContain: RegExp[] }> = [
  {
    file: "apps/web/src/components/memo-card.tsx",
    path: "../components/memo-card.tsx",
    mustContain: [
      /import \{ HealthMemoLabels \} from "@\/health\/memo-labels"/,
      /<HealthMemoLabels memo=\{memo\} \/>/,
    ],
  },
  {
    file: "apps/web/src/App.tsx",
    path: "../App.tsx",
    mustContain: [
      /import \{ HealthWeekStrip \} from "@\/health\/week-strip"/,
      /<HealthWeekStrip visible=\{view === "all" && !hasFilters\} \/>/,
    ],
  },
  {
    file: "apps/web/src/router-tree.tsx",
    path: "../router-tree.tsx",
    mustContain: [
      /import \{ healthRoute \} from "@\/health\/route"/,
      /^\s*healthRoute,/m,
    ],
  },
  {
    file: "apps/web/src/planner/nav-link.tsx",
    path: "../planner/nav-link.tsx",
    mustContain: [
      /import \{ HealthNavLink \} from "@\/health\/nav-link"/,
      /<HealthNavLink onNavigate=\{onNavigate\} \/>/,
    ],
  },
  {
    file: "apps/web/public/sw.js",
    path: "../../public/sw.js",
    mustContain: [/\$\{scopePath\}health`/],
  },
  {
    file: "apps/worker/src/spa-routes.ts",
    path: "../../../worker/src/spa-routes.ts",
    mustContain: [/"\/health",/],
  },
  {
    file: "apps/worker/src/index.ts",
    path: "../../../worker/src/index.ts",
    mustContain: [
      /mountLazyRoute\(app, "\/api\/app\/health-tracker"/,
      /import\("\.\/routes\/health-api"\)/,
    ],
  },
  {
    file: "apps/worker/src/scheduled-tasks.ts",
    path: "../../../worker/src/scheduled-tasks.ts",
    mustContain: [
      /import \{ healthNightlySweep \} from "@flaremo\/domain\/src\/health\/sync"/,
      /await healthNightlySweep\(db, /,
    ],
  },
  {
    file: "packages/domain/src/memos-write.ts",
    path: "../../../../packages/domain/src/memos-write.ts",
    mustContain: [
      /import \{ forkHealthSyncMemo \} from "\.\/health\/after-memo-write"/,
      /await forkHealthSyncMemo\(db, row\.id\);/,
      /await forkHealthSyncMemo\(db, id\);/,
    ],
  },
  {
    file: "packages/contracts/src/planner.ts",
    path: "../../../../packages/contracts/src/planner.ts",
    mustContain: [/export \* from "\.\/fork-health";/],
  },
];

describe("the health tracker's hook-ins in upstream files", () => {
  for (const hook of hookIns) {
    it(`${hook.file} still carries its hook-in`, () => {
      const text = read(hook.path);
      for (const pattern of hook.mustContain) {
        expect(text, `${hook.file} should match ${pattern}`).toMatch(pattern);
      }
    });
  }

  it("the memo save path calls the sync from both createMemo and updateMemo", () => {
    const text = read("../../../../packages/domain/src/memos-write.ts");
    expect(text.match(/await forkHealthSyncMemo\(/g)).toHaveLength(2);
  });
});
