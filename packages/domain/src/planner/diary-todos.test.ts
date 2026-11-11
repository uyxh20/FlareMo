import { describe, expect, it } from "vitest";
import {
  plannerAgentFromDiary,
  plannerDiaryTodoLines,
  plannerTodoMatch,
  plannerTodoQuoteIn,
  plannerTodoSourceKey,
  plannerTodoWords,
} from "./diary-todos";

// Diary to-dos (docs/fork-general-agent.md, "To-dos from the diary"): the word
// rules find_todos lists lines by, and the loose match against the board.

describe("plannerDiaryTodoLines", () => {
  it("takes open boxes and marker sentences, in the entry's own words", () => {
    const lines = plannerDiaryTodoLines(
      [
        "Long day at work. I need to renew the passport before March.",
        "- [ ] call the bank",
        "- [x] buy milk",
        "Felt good after the run.",
        "Don't forget Lea's birthday on Friday!",
        "#gym #out",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { quote: "I need to renew the passport before March.", checkbox: false },
      { quote: "call the bank", checkbox: true },
      { quote: "Don't forget Lea's birthday on Friday!", checkbox: false },
    ]);
  });

  it("leaves out what was done or only regretted", () => {
    expect(
      plannerDiaryTodoLines(
        "I should have called earlier. I had to leave at six. I was going to swim.",
      ),
    ).toEqual([]);
  });

  it("reads French markers too", () => {
    expect(
      plannerDiaryTodoLines(
        "Il faut que je rappelle le proprio. Belle journée.",
      ).map((line) => line.quote),
    ).toEqual(["Il faut que je rappelle le proprio."]);
  });

  it("lists a repeated line once and cuts a long one at a word", () => {
    const long = `I need to ${"write the long report ".repeat(30)}`;
    const lines = plannerDiaryTodoLines(
      `- [ ] call mum\n- [ ] call mum\n${long}`,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]?.quote.length).toBeLessThanOrEqual(280);
    expect(long).toContain(lines[1]?.quote ?? "x");
  });
});

describe("plannerTodoMatch", () => {
  const tasks = [
    { id: "t1", title: "Renew passport" },
    { id: "t2", title: "Call" },
    { id: "t3", title: "Plan the Lisbon trip" },
  ];

  it("finds the task that covers a line", () => {
    expect(
      plannerTodoMatch("I need to renew the passport before March.", tasks)?.id,
    ).toBe("t1");
    expect(
      plannerTodoMatch("should plan the Lisbon trip with Lea", tasks)?.id,
    ).toBe("t3");
  });

  it("takes no single shared word as a match", () => {
    expect(plannerTodoMatch("call the bank", tasks)).toBeNull();
    expect(plannerTodoMatch("buy a new bike", tasks)).toBeNull();
  });

  it("drops filler words and accents", () => {
    expect([
      ...plannerTodoWords("Il faut que je rappelle le propriétaire"),
    ]).toEqual(["rappelle", "proprietaire"]);
  });
});

describe("the source of a to-do", () => {
  it("finds the words in the entry whatever the case and punctuation", () => {
    const entry = "Busy.\n- [ ] Call the bank!\nI need to renew the passport.";
    expect(plannerTodoQuoteIn("call the bank", entry)).toBe(true);
    expect(plannerTodoQuoteIn("I need to renew the passport", entry)).toBe(
      true,
    );
    expect(plannerTodoQuoteIn("call the plumber", entry)).toBe(false);
    expect(plannerTodoQuoteIn("ca", entry)).toBe(false);
  });

  it("keys the same words the same way", () => {
    expect(plannerTodoSourceKey("m1", " Call  the bank ")).toBe(
      plannerTodoSourceKey("m1", "call the bank"),
    );
  });

  it("tells a diary to-do from any other new task", () => {
    expect(plannerAgentFromDiary({ source: { entry_id: "m1" } })).toBe(true);
    expect(plannerAgentFromDiary({ title: "x" })).toBe(false);
  });
});
