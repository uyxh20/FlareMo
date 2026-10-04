import {
  defaultParseSearch,
  defaultStringifySearch,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
// @ts-expect-error The host TS config does not allow JS imports; the feature JS is checked separately.
import { readFilters, readRoute } from "./navigation.js";

describe("team-project URL with TanStack's actual search serializer", () => {
  it("round-trips edit=true and a numeric-looking search query", () => {
    const serialized = defaultStringifySearch({
      project: "memo_123",
      edit: true,
      q: "123",
    });
    const parsed = defaultParseSearch(serialized);
    expect(parsed).toMatchObject({ project: "memo_123", edit: true, q: "123" });
    expect(readRoute("/team-projects", serialized)).toEqual({
      kind: "edit",
      id: "memos/memo_123",
    });
    expect(readFilters(serialized).query).toBe("123");
  });

  it("keeps older direct edit=1 links usable", () => {
    expect(readRoute("/team-projects", "?project=older_id&edit=1")).toEqual({
      kind: "edit",
      id: "memos/older_id",
    });
  });
});
