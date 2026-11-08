import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Link summaries (docs/fork-link-summaries.md) rest on three small hook-ins in
// upstream files. After an upstream sync that drops one, this fails loudly
// instead of the menu item vanishing, a redirect skipping the address check, or
// dreaming taking a summary of a web page as a fact about the owner.

const read = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

describe("the link summary hook-ins", () => {
  it("memo-card-menu.tsx renders the Summarize link item", () => {
    const text = read("apps/web/src/components/memo-card/memo-card-menu.tsx");
    expect(text).toMatch(/from "@\/fork\/summarize-link"/);
    expect(text).toContain("<ForkSummarizeLinkMenuItem memo={memo} />");
  });

  it("memos-link-metadata.ts exports its address check", () => {
    const text = read("apps/worker/src/memos-link-metadata.ts");
    expect(text).toMatch(/^export function validateExternalUrl\(/m);
  });

  it("memory dreaming skips link summaries", () => {
    const text = read("packages/domain/src/memory/consolidation.ts");
    expect(text).toMatch(/from "\.\.\/fork\/link-summary"/);
    expect(text).toContain("ne(memos.source, FORK_LINK_SUMMARY_SOURCE)");
  });
});
