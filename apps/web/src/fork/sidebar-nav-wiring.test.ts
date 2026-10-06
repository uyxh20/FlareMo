/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forkHiddenSidebarRoutes } from "./sidebar-nav";

// The sidebar filter only works while flaremo-explorer.tsx still routes its
// <nav> through ForkSidebarNav and still spells the three links the way the
// filter expects. After an upstream sync that renames or removes one of them,
// this fails loudly instead of the owner quietly seeing the entry come back
// (or the filter quietly matching nothing). See docs/fork-customizations.md.

const explorer = readFileSync(
  new URL("../components/flaremo-explorer.tsx", import.meta.url),
  "utf8",
);

describe("the sidebar hook-in in flaremo-explorer.tsx", () => {
  it("imports ForkSidebarNav from the fork module", () => {
    expect(explorer).toMatch(
      /import\s*\{[^}]*\bForkSidebarNav\b[^}]*\}\s*from\s*["']@\/fork\/sidebar-nav["']/,
    );
  });

  it("renders its navigation through ForkSidebarNav", () => {
    expect(explorer).toMatch(/<ForkSidebarNav[\s>]/);
    expect(explorer).toContain("</ForkSidebarNav>");
  });

  it("no longer renders a bare <nav>", () => {
    expect(explorer).not.toMatch(/<nav[\s>]/);
    expect(explorer).not.toContain("</nav>");
  });

  it("still has a link for every hidden route, spelled the way the filter matches", () => {
    for (const route of forkHiddenSidebarRoutes) {
      expect(explorer, `to="${route}" in flaremo-explorer.tsx`).toContain(
        `to="${route}"`,
      );
    }
  });
});
