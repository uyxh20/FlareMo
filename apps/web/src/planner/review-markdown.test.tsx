// @vitest-environment jsdom
import {
  plannerComposeSummaryMemo,
  plannerDiaryLine,
  plannerDiaryMarker,
  plannerReviewPrompts,
} from "@flaremo/contracts";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlannerMarkdown,
  plannerInlineMarkdown,
  plannerMarkdownBlocks,
} from "./review-markdown";
import { type PlannerTestMount, plannerTestMount } from "./test-render";

// The memo of the week of Monday 5 October 2026.
const WEEK = "2026-10-05";

/**
 * A line's inline parts as text: plain text as it is (pieces next to each other
 * joined), an element as `<tag>text</tag>`.
 */
function inline(text: string): string[] {
  const parts: string[] = [];
  let plain = false;
  for (const node of plannerInlineMarkdown(text) as ReactNode[]) {
    if (typeof node === "string") {
      if (plain) parts.push(`${parts.pop() ?? ""}${node}`);
      else parts.push(node);
      plain = true;
      continue;
    }
    plain = false;
    parts.push(
      isValidElement<{ children: string }>(node)
        ? `<${String(node.type)}>${node.props.children}</${String(node.type)}>`
        : `unexpected ${String(node)}`,
    );
  }
  return parts;
}

let mounted: PlannerTestMount | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  for (const leftover of Array.from(document.body.children)) leftover.remove();
});

/** The memo drawn as the memo sheet draws it. */
function show(markdown: string, live = false): HTMLElement {
  mounted?.unmount();
  mounted = plannerTestMount(
    <PlannerMarkdown
      markdown={markdown}
      live={live}
      diaryLabel={(from, to) => `Diary ${from} to ${to}`}
    />,
  );
  const root = mounted.container.querySelector(".planner-md");
  if (!(root instanceof HTMLElement)) throw new Error("No memo was drawn.");
  return root;
}

const tags = (root: Element) =>
  Array.from(root.children).map((child) => child.tagName.toLowerCase());

const cursors = (root: Element) =>
  Array.from(root.querySelectorAll(".planner-md-cursor"));

describe("plannerMarkdownBlocks", () => {
  it("reads headings, the deepest ones drawn as level 4", () => {
    expect(
      plannerMarkdownBlocks(
        "# Week 41\n## Executive Summary\n### I. Objective Function\n##### Deep\n###### Deeper",
      ),
    ).toEqual([
      { kind: "h", level: 1, text: "Week 41" },
      { kind: "h", level: 2, text: "Executive Summary" },
      { kind: "h", level: 3, text: "I. Objective Function" },
      { kind: "h", level: 4, text: "Deep" },
      { kind: "h", level: 4, text: "Deeper" },
    ]);
    // No space after the hashes: not a heading.
    expect(plannerMarkdownBlocks("#hashtag")).toEqual([
      { kind: "p", lines: ["#hashtag"] },
    ]);
  });

  it("joins a paragraph's lines and splits paragraphs at blank lines", () => {
    expect(
      plannerMarkdownBlocks(
        "Shipped the beta.  \r\nTwo runs, not three.\r\n\r\n   \nNext paragraph.",
      ),
    ).toEqual([
      { kind: "p", lines: ["Shipped the beta.", "Two runs, not three."] },
      { kind: "p", lines: ["Next paragraph."] },
    ]);
    expect(plannerMarkdownBlocks("")).toEqual([]);
    expect(plannerMarkdownBlocks("\n\n  \n")).toEqual([]);
  });

  it("reads bullet lists with their sub-items", () => {
    expect(
      plannerMarkdownBlocks(
        "- **Impact:** shipped\n  - the invoices slipped\n* second\n+ third",
      ),
    ).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "**Impact:** shipped", sub: false },
          { text: "the invoices slipped", sub: true },
          { text: "second", sub: false },
          { text: "third", sub: false },
        ],
      },
    ]);
  });

  it("reads numbered lists with their numbers, sub-items of either kind staying in them", () => {
    expect(
      plannerMarkdownBlocks("4. Four\n   - a detail\n5) Five\n   1. a step"),
    ).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          { text: "Four", sub: false, value: 4 },
          { text: "a detail", sub: true },
          { text: "Five", sub: false, value: 5 },
          { text: "a step", sub: true },
        ],
      },
    ]);
  });

  it("starts a new list when the kind changes, and ends one at a line of text", () => {
    expect(plannerMarkdownBlocks("- one\n1. two\nAfter the list.")).toEqual([
      { kind: "list", ordered: false, items: [{ text: "one", sub: false }] },
      {
        kind: "list",
        ordered: true,
        items: [{ text: "two", sub: false, value: 1 }],
      },
      { kind: "p", lines: ["After the list."] },
    ]);
  });

  it("keeps a table's rows together, between the text around it", () => {
    expect(
      plannerMarkdownBlocks(
        "- **Scores (W41):**\n| Measure | Score |\n|---|---:|\n| Authenticity | 4.0/5 |\nAfter the table.",
      ),
    ).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [{ text: "**Scores (W41):**", sub: false }],
      },
      {
        kind: "table",
        rows: ["| Measure | Score |", "|---|---:|", "| Authenticity | 4.0/5 |"],
      },
      { kind: "p", lines: ["After the table."] },
    ]);
  });

  it("reads rules written with dashes, stars or underscores", () => {
    expect(plannerMarkdownBlocks("Above\n---\n***\n ___ \nBelow")).toEqual([
      { kind: "p", lines: ["Above"] },
      { kind: "hr" },
      { kind: "hr" },
      { kind: "hr" },
      { kind: "p", lines: ["Below"] },
    ]);
  });

  it("hides HTML comments", () => {
    expect(
      plannerMarkdownBlocks(
        "<!-- written by the model -->\nOne\n  <!-- aside -->\nTwo",
      ),
    ).toEqual([{ kind: "p", lines: ["One", "Two"] }]);
  });

  it("turns the diary marker into a diary block, dropping the template's line above it", () => {
    const memo = `## 4. Raw Logs for this Week\n\n${plannerDiaryLine(WEEK)}\n\n${plannerDiaryMarker(WEEK)}`;
    expect(plannerDiaryLine(WEEK)).toBe(
      "Diary entries from 5 to 11 October 2026.",
    );
    expect(plannerMarkdownBlocks(memo)).toEqual([
      { kind: "h", level: 2, text: "4. Raw Logs for this Week" },
      { kind: "diary", from: "2026-10-05", to: "2026-10-11" },
    ]);
    // Right above it, too, and with the marker written loosely.
    expect(
      plannerMarkdownBlocks(
        "Diary entries from 28 September to 4 October 2026.\n  <!--flaremo:diary   2026-09-28..2026-10-04   -->",
      ),
    ).toEqual([{ kind: "diary", from: "2026-09-28", to: "2026-10-04" }]);
  });

  it("keeps the text above the marker when it is not the template's line", () => {
    const marker = plannerDiaryMarker(WEEK);
    expect(plannerMarkdownBlocks(`See the diary.\n\n${marker}`)).toEqual([
      { kind: "p", lines: ["See the diary."] },
      { kind: "diary", from: "2026-10-05", to: "2026-10-11" },
    ]);
    expect(
      plannerMarkdownBlocks(`Notes:\n${plannerDiaryLine(WEEK)}\n\n${marker}`),
    ).toEqual([
      { kind: "p", lines: ["Notes:", plannerDiaryLine(WEEK)] },
      { kind: "diary", from: "2026-10-05", to: "2026-10-11" },
    ]);
  });

  it("holds back a last line that is only a marker so far while the memo is written", () => {
    for (const last of [
      "",
      "  ",
      "-",
      "- ",
      "*",
      "+",
      "12.",
      "3)",
      "##",
      "|",
      "--",
      "**",
      "_",
      "<",
      "<!-",
      "<!-- flaremo:",
    ]) {
      expect(
        plannerMarkdownBlocks(`## Next Steps\nShip it.\n${last}`, true),
        JSON.stringify(last),
      ).toEqual([
        { kind: "h", level: 2, text: "Next Steps" },
        { kind: "p", lines: ["Ship it."] },
      ]);
    }
    // A marker with text after it is drawn.
    expect(plannerMarkdownBlocks("- Ship", true)).toEqual([
      { kind: "list", ordered: false, items: [{ text: "Ship", sub: false }] },
    ]);
    // Once the memo is whole, nothing is held back.
    expect(plannerMarkdownBlocks("Ship it.\n#")).toEqual([
      { kind: "p", lines: ["Ship it.", "#"] },
    ]);
  });

  // The model copies the diary marker as the memo's last line. Comments are
  // never shown, so a half-typed one must not flash on screen as text either.
  it("holds back a half-typed diary marker while the memo is written", () => {
    const half = plannerDiaryMarker(WEEK).slice(0, 36);
    expect(half).toBe("<!-- flaremo:diary 2026-10-05..2026-");
    expect(plannerMarkdownBlocks(`Ship it.\n\n${half}`, true)).toEqual([
      { kind: "p", lines: ["Ship it."] },
    ]);
  });

  it("reads the page's own memo template into the blocks it is made of", () => {
    const memo = plannerComposeSummaryMemo({
      weekStart: WEEK,
      reviewedOn: "2026-10-11",
      recap: "The beta shipped.",
      lastQuestion: null,
      lastAnswer: [],
      goals: [],
      answers: plannerReviewPrompts.map(() => ["Fine."]),
      scores: { auth: 4, ach: 3.5 },
      authBasis: "Named the skipped runs.",
      achBasis: "The beta shipped.",
      trajectory: { pattern: "", risk: "", opportunity: "" },
      question: null,
      verdict: null,
      recommended: null,
    });
    const blocks = plannerMarkdownBlocks(memo);
    expect(blocks[0]).toEqual({
      kind: "h",
      level: 1,
      text: expect.stringMatching(/^Week 41: /),
    });
    expect(blocks.filter((block) => block.kind === "table")).toHaveLength(1);
    expect(blocks.at(-1)).toEqual({
      kind: "diary",
      from: "2026-10-05",
      to: "2026-10-11",
    });
    const text = JSON.stringify(blocks);
    expect(text).not.toContain("Diary entries from");
    expect(text).not.toContain("<!--");
  });
});

describe("plannerInlineMarkdown", () => {
  it("reads code, bold and italics with stars or underscores", () => {
    expect(inline("Run `pnpm test` before **every** push, *always*.")).toEqual([
      "Run ",
      "<code>pnpm test</code>",
      " before ",
      "<strong>every</strong>",
      " push, ",
      "<em>always</em>",
      ".",
    ]);
    expect(inline("_Pause_ for pricing (_maybe_)")).toEqual([
      "<em>Pause</em>",
      " for pricing (",
      "<em>maybe</em>",
      ")",
    ]);
    expect(inline("**Last week's key question:** *Did I rest?* Yes")).toEqual([
      "<strong>Last week's key question:</strong>",
      " ",
      "<em>Did I rest?</em>",
      " Yes",
    ]);
  });

  it("leaves stars and underscores inside words and sums as they are", () => {
    expect(inline("snake_case_name and 2 * 3 * 4")).toEqual([
      "snake_case_name and 2 * 3 * 4",
    ]);
    expect(inline("x*y*z")).toEqual(["x*y*z"]);
  });

  it("keeps marks inside code as written", () => {
    expect(inline("`a **b** _c_`")).toEqual(["<code>a **b** _c_</code>"]);
  });

  it("gives back plain text whole, and nothing for nothing", () => {
    expect(inline("Plain text.")).toEqual(["Plain text."]);
    expect(inline("")).toEqual([]);
  });
});

describe("PlannerMarkdown", () => {
  it("draws headings, paragraphs, lists, rules and tables as elements", () => {
    const root = show(
      [
        "# Week 41",
        "",
        "## Executive Summary",
        "",
        "Shipped the beta.",
        "Two runs.",
        "",
        "---",
        "",
        "- **Impact:** shipped",
        "  - the invoices slipped",
        "1. One",
        "2. Two",
        "",
        "| Measure | Score | Basis |",
        "|:---:|---:|---|",
        "| Authenticity | 4.0/5 | *Named* it |",
      ].join("\n"),
    );
    expect(tags(root)).toEqual(["h1", "h2", "p", "hr", "ul", "ol", "div"]);
    expect(root.querySelector("h1")?.textContent).toBe("Week 41");
    const paragraph = root.querySelector("p");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
    expect(paragraph?.textContent).toBe("Shipped the beta.Two runs.");

    const bullets = Array.from(root.querySelectorAll("ul > li"));
    expect(bullets.map((item) => item.textContent)).toEqual([
      "Impact: shipped",
      "the invoices slipped",
    ]);
    expect(bullets[0]?.querySelector("strong")?.textContent).toBe("Impact:");
    expect(bullets.map((item) => item.hasAttribute("data-sub"))).toEqual([
      false,
      true,
    ]);
    const numbered = Array.from(root.querySelectorAll("ol > li"));
    expect(numbered.map((item) => item.getAttribute("value"))).toEqual([
      "1",
      "2",
    ]);

    const table = root.querySelector(".planner-md-table table");
    const heads = Array.from(table?.querySelectorAll("thead th") ?? []);
    expect(heads.map((cell) => cell.textContent)).toEqual([
      "Measure",
      "Score",
      "Basis",
    ]);
    expect(heads.map((cell) => (cell as HTMLElement).style.textAlign)).toEqual([
      "center",
      "right",
      "",
    ]);
    const cells = Array.from(table?.querySelectorAll("tbody td") ?? []);
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "Authenticity",
      "4.0/5",
      "Named it",
    ]);
    expect(cells[2]?.querySelector("em")?.textContent).toBe("Named");
    expect((cells[1] as HTMLElement | undefined)?.style.textAlign).toBe(
      "right",
    );
  });

  it("draws a table with no header row as body rows only", () => {
    const root = show("| a | b |\n| c | d |");
    expect(root.querySelector("thead")).toBeNull();
    expect(
      Array.from(root.querySelectorAll("tbody tr")).map((row) =>
        Array.from(row.children).map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("draws the diary marker as its chip, without the line above it or any comment", () => {
    const root = show(
      [
        "Shipped the beta.",
        "",
        "<!-- a note for the model -->",
        "",
        plannerDiaryLine(WEEK),
        "",
        plannerDiaryMarker(WEEK),
      ].join("\n"),
    );
    expect(root.querySelector(".planner-md-diary")?.textContent).toBe(
      "Diary 2026-10-05 to 2026-10-11",
    );
    expect(root.textContent).toBe(
      "Shipped the beta.Diary 2026-10-05 to 2026-10-11",
    );
  });

  it("never turns the memo's text into HTML", () => {
    const root = show(
      '<b>bold?</b> <img src="x" onerror="alert(1)">\n\n**<i>x</i>**\n\n<script>alert(1)</script>',
    );
    expect(root.querySelector("b, i, img, script")).toBeNull();
    expect(root.textContent).toContain(
      '<b>bold?</b> <img src="x" onerror="alert(1)">',
    );
    expect(root.querySelector("strong")?.textContent).toBe("<i>x</i>");
  });

  it("blinks a cursor at the end of the last block while the memo is written, and only then", () => {
    const lastHas = (markdown: string, selector: string) => {
      const root = show(markdown, true);
      expect(cursors(root), markdown).toHaveLength(1);
      expect(
        root.querySelector(selector)?.querySelector(".planner-md-cursor"),
        markdown,
      ).not.toBeNull();
    };
    lastHas("# Week 41", "h1");
    lastHas("# Week 41\n\nShip the", "p");
    lastHas("- one\n- two", "li:last-child");
    lastHas("| a | b |", "div:has(> .planner-md-table)");
    lastHas(plannerDiaryMarker(WEEK), "p:has(> .planner-md-diary)");
    // Nothing yet: the cursor alone.
    const empty = show("", true);
    expect(empty.children).toHaveLength(1);
    expect(cursors(empty)).toHaveLength(1);
    // A half-typed list marker is held back; the cursor follows the text before it.
    const held = show("Ship it.\n- ", true);
    expect(tags(held)).toEqual(["p"]);
    expect(held.querySelector("p .planner-md-cursor")).not.toBeNull();
    // The finished memo has none.
    expect(cursors(show("# Week 41\n\nShip it."))).toHaveLength(0);
    expect(cursors(show(""))).toHaveLength(0);
  });

  // A memo that ends on `---` while it streams keeps its cursor.
  it("keeps the cursor when the memo written so far ends on a rule", () => {
    const root = show("Pattern holds.\n\n---", true);
    expect(cursors(root)).toHaveLength(1);
  });
});
