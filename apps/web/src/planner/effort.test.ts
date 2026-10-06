import { describe, expect, it } from "vitest";
import { plannerFormatEffort, plannerParseEffort } from "./effort";

describe("plannerParseEffort", () => {
  it("reads blank text as clearing the estimate", () => {
    for (const text of ["", " ", "\t\n"]) {
      expect(plannerParseEffort(text), JSON.stringify(text)).toEqual({
        ok: true,
        value: null,
      });
    }
  });

  it("reads a number from 0 to 999 with at most one decimal", () => {
    const cases: Array<[string, number]> = [
      ["0", 0],
      ["3", 3],
      ["3.5", 3.5],
      [" 12.3 ", 12.3],
      ["999", 999],
      ["0.1", 0.1],
      [".5", 0.5],
      ["3.", 3],
      ["007", 7],
      // A trailing zero is not a second decimal: the value has one.
      ["3.50", 3.5],
      ["3.0", 3],
    ];
    for (const [text, value] of cases) {
      expect(plannerParseEffort(text), text).toEqual({ ok: true, value });
    }
  });

  it("reads a comma as the decimal point", () => {
    expect(plannerParseEffort("3,5")).toEqual({ ok: true, value: 3.5 });
    expect(plannerParseEffort("0,1")).toEqual({ ok: true, value: 0.1 });
  });

  it("refuses what the server would answer 400 to", () => {
    for (const text of [
      "1000",
      "999.1",
      "3.25",
      "0.05",
      "-1",
      "-0",
      "+3",
      "1e2",
      "0x10",
      "abc",
      "3 5",
      "3,5,1",
      "1.2.3",
      ".",
      "Infinity",
      "NaN",
    ]) {
      expect(plannerParseEffort(text), text).toEqual({ ok: false });
    }
  });

  it("never returns a value with float noise", () => {
    const parsed = plannerParseEffort("1.1");
    expect(parsed).toEqual({ ok: true, value: 1.1 });
  });
});

describe("plannerFormatEffort", () => {
  it("shows nothing for no estimate, and the number as it is otherwise", () => {
    expect(plannerFormatEffort(null)).toBe("");
    expect(plannerFormatEffort(undefined)).toBe("");
    expect(plannerFormatEffort(0)).toBe("0");
    expect(plannerFormatEffort(3)).toBe("3");
    expect(plannerFormatEffort(3.5)).toBe("3.5");
    expect(plannerFormatEffort(999)).toBe("999");
  });

  it("round-trips through the parser", () => {
    for (const value of [0, 0.1, 1, 3.5, 12.3, 999]) {
      expect(plannerParseEffort(plannerFormatEffort(value))).toEqual({
        ok: true,
        value,
      });
    }
  });
});
