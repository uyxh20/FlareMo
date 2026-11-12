import { describe, expect, it } from "vitest";
import {
  plannerMarkdownLines,
  plannerToggleMarkdownTodo,
} from "./task-markdown";

// How task notes and comments are read as Markdown (task-markdown.tsx). The
// sample is made up, written the way plans are written in the cockpit.

const PLAN = `Execution plan: bakery shop site
Aim: no order waits more than a day.

0. Unblock now
- [ ] Reply to the café
- [x] Draft the cake reply
  - [ ] Ask for photos
- Note: prefers calls

## Later
1. One inbox
2. Same price
> Rule of thumb
---`;

describe("reading a note as Markdown", () => {
  const lines = plannerMarkdownLines(PLAN, { title: true });
  const kinds = lines.map((line) => line.kind);

  it("reads one row per source line", () => {
    expect(lines).toHaveLength(PLAN.split("\n").length);
  });

  it("makes the first line of a longer note its title, and a short Label: bold", () => {
    expect(lines[0]).toEqual({
      kind: "title",
      text: "Execution plan: bakery shop site",
    });
    expect(lines[1]).toEqual({
      kind: "text",
      label: "Aim",
      text: "no order waits more than a day.",
    });
  });

  it("treats a numbered line straight above a list as a section heading", () => {
    expect(lines[3]).toEqual({
      kind: "section",
      number: "0",
      text: "Unblock now",
    });
    // A run of numbered lines stays a numbered list.
    expect(lines[10]).toMatchObject({ kind: "numbered", number: "1" });
    expect(lines[11]).toMatchObject({ kind: "numbered", number: "2" });
  });

  it("reads to-dos, done or not, nested by two spaces", () => {
    expect(lines[4]).toEqual({
      kind: "todo",
      indent: 0,
      done: false,
      text: "Reply to the café",
    });
    expect(lines[5]).toMatchObject({ kind: "todo", done: true });
    expect(lines[6]).toMatchObject({ kind: "todo", indent: 1, done: false });
    expect(lines[7]).toMatchObject({
      kind: "bullet",
      text: "Note: prefers calls",
    });
  });

  it("reads headings, quotes, rules and blank lines", () => {
    expect(kinds[2]).toBe("blank");
    expect(lines[9]).toEqual({ kind: "heading", level: 2, text: "Later" });
    expect(lines[12]).toEqual({ kind: "quote", text: "Rule of thumb" });
    expect(kinds[13]).toBe("rule");
  });

  it("has no title in a short note, or in comments", () => {
    expect(plannerMarkdownLines("Just one line", { title: true })[0].kind).toBe(
      "text",
    );
    expect(plannerMarkdownLines(PLAN)[0].kind).toBe("text");
  });
});

describe("ticking a to-do", () => {
  it("rewrites only that line, both ways, keeping the indent", () => {
    const ticked = plannerToggleMarkdownTodo(PLAN, 4);
    expect(ticked.split("\n")[4]).toBe("- [x] Reply to the café");
    expect(plannerToggleMarkdownTodo(PLAN, 5).split("\n")[5]).toBe(
      "- [ ] Draft the cake reply",
    );
    expect(plannerToggleMarkdownTodo(PLAN, 6).split("\n")[6]).toBe(
      "  - [x] Ask for photos",
    );
    const rest = (text: string) =>
      text.split("\n").filter((_, index) => index !== 4);
    expect(rest(ticked)).toEqual(rest(PLAN));
  });

  it("leaves a line that is not a to-do, or a line that does not exist, alone", () => {
    expect(plannerToggleMarkdownTodo(PLAN, 0)).toBe(PLAN);
    expect(plannerToggleMarkdownTodo(PLAN, 99)).toBe(PLAN);
  });
});
