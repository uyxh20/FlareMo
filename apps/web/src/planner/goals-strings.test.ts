import { plannerGoalResults, plannerPillars } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import { plannerGoalsStringsFor } from "./goals-strings";
import { plannerGoalsNavLabelFor, plannerReviewNavLabelFor } from "./nav-label";

const en = plannerGoalsStringsFor("en-US");
const zh = plannerGoalsStringsFor("zh-CN");

type Leaf = string | ((...args: never[]) => string);

/** Every leaf of a strings tree, as `path` and a flag for template functions. */
function leaves(value: unknown, path = ""): { path: string; fn: boolean }[] {
  if (typeof value === "string") return [{ path, fn: false }];
  if (typeof value === "function") return [{ path, fn: true }];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leaves(child, path ? `${path}.${key}` : key),
  );
}

function read(root: unknown, path: string): Leaf {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      root,
    ) as Leaf;
}

/** Every template function called with sample values, by path. */
function samples(strings: typeof en): Record<string, string> {
  const forward = strings.review.forward;
  return {
    range: strings.range({ month: 9, day: 5 }, { month: 9, day: 11 }),
    rangeAcross: strings.range({ month: 8, day: 28 }, { month: 9, day: 4 }),
    week: strings.week(41),
    weekCode: strings.weekCode(41),
    weekLine: strings.cockpit.weekLine("Week 42", "12 – 18 Oct"),
    year: strings.goals.year(2026),
    quarter: strings.goals.quarter(4),
    floor: strings.goals.floor("4.0"),
    scores: strings.goals.scores("4.0", "3.5"),
    goalCount: strings.goals.goalCount(3),
    edit: strings.editor.edit("Work"),
    stepOf: strings.review.stepOf(2, 4),
    promptOf: strings.review.promptOf(3, 7),
    lower: strings.review.lower("Authenticity"),
    raise: strings.review.raise("Authenticity"),
    chartsTitle: strings.review.chartsTitle("W23", "W41"),
    chartLabel: strings.review.chartLabel("Authenticity", "W23", "W41", "4.0"),
    memoTitle: strings.review.memo.title("Week 41"),
    diary: strings.review.memo.diary("5 – 11 Oct"),
    memoLabel: strings.review.memo.label("Week 41"),
    open: forward.open(2),
    fromSummary: forward.fromSummary("Week 41"),
    goalFor: forward.goalFor("Work"),
    newTaskFor: forward.newTaskFor("Work"),
    fromBoardFor: forward.fromBoardFor("Work"),
    savedToast: forward.savedToast("Week 42"),
    backTo: forward.backTo("Check goals"),
    nextTo: forward.nextTo("Plan tasks"),
  };
}

describe("plannerGoalsStringsFor", () => {
  it("speaks Chinese for zh-CN and English for every other app language", () => {
    expect(zh.intlLocale).toBe("zh-CN");
    expect(en.intlLocale).toBe("en-US");
    for (const locale of ["en-US", "ja", "fr", "es", "ko", "ru", "ar", "zh"]) {
      expect(plannerGoalsStringsFor(locale), locale).toBe(en);
    }
  });

  it("gives both languages the same keys, as text or as template functions taking the same arguments", () => {
    const english = leaves(en);
    const chinese = leaves(zh);
    expect(chinese.map((leaf) => leaf.path).sort()).toEqual(
      english.map((leaf) => leaf.path).sort(),
    );
    for (const leaf of english) {
      const mine = read(en, leaf.path);
      const theirs = read(zh, leaf.path);
      expect(typeof theirs, leaf.path).toBe(typeof mine);
      if (typeof mine === "function" && typeof theirs === "function") {
        expect(theirs.length, leaf.path).toBe(mine.length);
      }
    }
  });

  it("covers every template function with a sample, so none is left untested", () => {
    const functions = leaves(en).filter((leaf) => leaf.fn);
    // range is sampled twice, within one month and across two.
    expect(Object.keys(samples(en))).toHaveLength(functions.length + 1);
  });

  it("leaves no text empty, written or filled in", () => {
    for (const [name, strings] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      for (const leaf of leaves(strings).filter((entry) => !entry.fn)) {
        const text = read(strings, leaf.path) as string;
        expect(text.trim().length, `${name}:${leaf.path}`).toBeGreaterThan(0);
      }
      for (const [path, text] of Object.entries(samples(strings))) {
        expect(text.trim().length, `${name}:${path}`).toBeGreaterThan(0);
        expect(text, `${name}:${path}`).not.toContain("undefined");
      }
    }
  });

  it("names every objective, result, status and verdict, and twelve months twice", () => {
    for (const strings of [en, zh]) {
      expect(Object.keys(strings.pillar).sort()).toEqual(
        [...plannerPillars].sort(),
      );
      expect(Object.keys(strings.pillarShort).sort()).toEqual(
        [...plannerPillars].sort(),
      );
      expect(Object.keys(strings.result).sort()).toEqual(
        [...plannerGoalResults].sort(),
      );
      expect(strings.months).toHaveLength(12);
      expect(strings.monthsLong).toHaveLength(12);
      expect(strings.review.forward.steps).toHaveLength(4);
    }
    expect(en.months[0]).toBe("Jan");
    expect(en.months[9]).toBe("Oct");
    expect(en.monthsLong[9]).toBe("October");
    expect(zh.months[9]).toBe("10月");
    expect(zh.monthsLong[11]).toBe("十二月");
  });

  it("names the pages as their nav links do", () => {
    expect(en.goals.title).toBe(plannerGoalsNavLabelFor("en-US"));
    expect(en.review.title).toBe(plannerReviewNavLabelFor("en-US"));
    expect(zh.goals.title).toBe(plannerGoalsNavLabelFor("zh-CN"));
    expect(zh.review.title).toBe(plannerReviewNavLabelFor("zh-CN"));
    expect(en.goals.title).toBe("Goals");
    expect(en.review.title).toBe("Weekly review");
  });

  it("writes a week's days within a month and across two", () => {
    expect(en.range({ month: 9, day: 5 }, { month: 9, day: 11 })).toBe(
      "5 – 11 Oct",
    );
    expect(en.range({ month: 8, day: 28 }, { month: 9, day: 4 })).toBe(
      "28 Sep – 4 Oct",
    );
    expect(en.range({ month: 11, day: 28 }, { month: 0, day: 3 })).toBe(
      "28 Dec – 3 Jan",
    );
    expect(zh.range({ month: 9, day: 5 }, { month: 9, day: 11 })).toBe(
      "10月5日 – 11日",
    );
    expect(zh.range({ month: 8, day: 28 }, { month: 9, day: 4 })).toBe(
      "9月28日 – 10月4日",
    );
  });

  it("fills in weeks, counts, scores and steps", () => {
    expect(samples(en)).toEqual({
      range: "5 – 11 Oct",
      rangeAcross: "28 Sep – 4 Oct",
      week: "Week 41",
      weekCode: "W41",
      weekLine: "Week 42 · 12 – 18 Oct",
      year: "2026",
      quarter: "Q4",
      floor: "floor 4.0",
      scores: "Auth 4.0 · Ach 3.5",
      goalCount: "3 goals",
      edit: "Edit Work",
      stepOf: "Step 2 of 4",
      promptOf: "3 / 7",
      lower: "Lower Authenticity",
      raise: "Raise Authenticity",
      chartsTitle: "Scores · W23 – W41",
      chartLabel: "Authenticity by week, W23 to W41, floor 4.0",
      memoTitle: "Week 41 summary",
      diary: "Diary entries · 5 – 11 Oct",
      memoLabel: "Week 41 summary memo",
      open: "2 open",
      fromSummary: "From Week 41 summary",
      goalFor: "Work goal",
      newTaskFor: "New task for Work",
      fromBoardFor: "Add a task from the board for Work",
      savedToast: "Week 42 saved",
      backTo: "← Check goals",
      nextTo: "Plan tasks →",
    });
    expect(en.goals.goalCount(1)).toBe("1 goal");
    expect(en.goals.goalCount(0)).toBe("0 goals");
    expect(zh.week(41)).toBe("第 41 周");
    expect(zh.weekCode(41)).toBe("W41");
    expect(zh.goals.year(2026)).toBe("2026 年");
    expect(zh.goals.goalCount(1)).toBe("1 个目标");
    expect(zh.goals.scores("4.0", "3.5")).toBe("真实 4.0 · 达成 3.5");
    expect(zh.review.stepOf(2, 4)).toBe("第 2 步，共 4 步");
    expect(zh.review.forward.open(2)).toBe("2 个待处理");
    expect(zh.review.forward.savedToast("第 42 周")).toBe("第 42 周 已保存");
  });

  it("keeps Chinese text to full-width punctuation and the single ellipsis character", () => {
    const chinese = [
      ...leaves(zh)
        .filter((leaf) => !leaf.fn)
        .map((leaf) => read(zh, leaf.path) as string),
      ...Object.values(samples(zh)),
    ];
    for (const line of chinese) {
      expect(line, line).not.toMatch(/[一-鿿][,.!?:;]/);
      expect(line, line).not.toContain("...");
    }
    for (const line of [
      ...leaves(en)
        .filter((leaf) => !leaf.fn)
        .map((leaf) => read(en, leaf.path) as string),
      ...Object.values(samples(en)),
    ]) {
      expect(line, line).not.toContain("...");
    }
  });
});
