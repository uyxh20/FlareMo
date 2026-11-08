import { describe, expect, it } from "vitest";
import { forkLinksIn, forkSummarizeDraft } from "./summarize-link";

describe("Summarize link", () => {
  it("finds an entry's web addresses, without repeats or trailing punctuation", () => {
    expect(
      forkLinksIn(
        "Watch https://youtu.be/abc. Then (https://example.com/a) and https://youtu.be/abc again; ftp://no",
      ),
    ).toEqual(["https://youtu.be/abc", "https://example.com/a"]);
    expect(forkLinksIn("No links #today")).toEqual([]);
  });

  it("opens the chat with the request and the entry named", () => {
    expect(forkSummarizeDraft(["https://example.com/a"], "m1")).toBe(
      "Summarize the key points of this link into a diary entry:\nhttps://example.com/a\n(From my entry m1.)",
    );
  });
});
