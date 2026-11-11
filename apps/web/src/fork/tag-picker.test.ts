import { describe, expect, it } from "vitest";
import { filterTagSuggestions } from "@/lib/tag-autocomplete";
import { FORK_TAG_PICKER_LIMIT } from "./tag-picker";

describe("the fork's tag list limit", () => {
  it("offers every matching tag, not upstream's first six", () => {
    const tags = Array.from({ length: 40 }, (_, index) => ({
      name: `tag${index}`,
      count: 1,
    }));
    expect(filterTagSuggestions(tags, "", FORK_TAG_PICKER_LIMIT)).toHaveLength(
      40,
    );
    expect(filterTagSuggestions(tags, "")).toHaveLength(6);
  });
});
