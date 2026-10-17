import { describe, expect, it } from "vitest";
import { anthropicBody } from "./planner-review-ai";

describe("the Anthropic request body", () => {
  it("sends no temperature and leaves room for thinking", () => {
    const body = JSON.parse(
      anthropicBody(
        "claude-opus-5-5",
        [
          { role: "system", content: "Rules." },
          { role: "user", content: "The week." },
        ],
        { maxTokens: 400, temperature: 0.2 },
        true,
      ),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_tokens).toBe(4_400);
    expect(body.system).toBe("Rules.");
    expect(body.messages).toEqual([{ role: "user", content: "The week." }]);
    expect(body.stream).toBe(true);
  });
});
