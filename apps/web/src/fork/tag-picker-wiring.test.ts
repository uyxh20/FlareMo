/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The "#" list's one fork hook-in: it asks for the whole tag list. If an
// upstream sync drops it, the list quietly stops at six rows. See
// docs/fork-customizations.md.

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the tag picker hook-in", () => {
  it("useComposerSuggestions asks for the whole tag list", () => {
    const hook = source("hooks/use-composer-suggestions.ts");
    expect(hook).toContain('from "@/fork/tag-picker"');
    expect(hook).toContain(
      "filterTagSuggestions(tags, activeTagToken.text, FORK_TAG_PICKER_LIMIT)",
    );
  });
});
