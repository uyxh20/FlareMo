import { describe, expect, it } from "vitest";
import {
  healthChipText,
  healthDayShort,
  healthDotState,
  healthFormatUnits,
  healthLevel,
  healthMonthMarks,
  healthShare,
  healthStripDays,
  healthWeekdayShort,
  healthYearWeeks,
} from "./model";
import {
  healthTestEntry,
  healthTestNight,
  healthTestTrackers,
} from "./test-fixtures";

describe("units", () => {
  it("writes halves the way people do", () => {
    expect(healthFormatUnits(0)).toBe("0");
    expect(healthFormatUnits(0.5)).toBe("½");
    expect(healthFormatUnits(1)).toBe("1");
    expect(healthFormatUnits(2.5)).toBe("2½");
    expect(healthFormatUnits(1.25)).toBe("1.3");
  });
});

describe("days", () => {
  it("names the weekday and the day", () => {
    // 2026-10-12 is a Monday.
    expect(healthWeekdayShort("2026-10-12")).toBe("Mon");
    expect(healthWeekdayShort("2026-10-18")).toBe("Sun");
    expect(healthDayShort("2026-10-05")).toBe("5 Oct");
  });
});

describe("chip text", () => {
  it("names an owner's tracker by its label, with hours", () => {
    const entry = healthTestEntry({
      kind: "t:fast00000001",
      variant: null,
      minutes: 960,
    });
    expect(healthChipText(entry, healthTestTrackers())).toBe("Fasting · 16 h");
    expect(healthChipText({ ...entry, minutes: null }, [])).toBe("Tracker");
  });

  it("names a training session by its variant", () => {
    expect(healthChipText(healthTestEntry({ variant: "gym" }))).toBe("Gym");
    expect(healthChipText(healthTestEntry({ variant: "back" }))).toBe(
      "Gym · Back",
    );
    expect(healthChipText(healthTestEntry({ variant: "crossfit" }))).toBe(
      "CrossFit",
    );
    expect(
      healthChipText(healthTestEntry({ variant: "cardio", minutes: 40 })),
    ).toBe("Cardio · 40 min");
  });

  it("names a breath session with its minutes", () => {
    expect(
      healthChipText(
        healthTestEntry({ kind: "breath", variant: "wim_hof", minutes: 10 }),
      ),
    ).toBe("Wim Hof · 10 min");
  });

  it("names a night by its weekday, home time and units", () => {
    expect(
      healthChipText(
        healthTestNight({ day: "2026-10-09", home_at: "03:30", units: 1 }),
      ),
    ).toBe("Night out · Fri · home 03:30 · 1");
    expect(
      healthChipText(
        healthTestNight({ day: "2026-10-10", home_at: "01:00", units: 0.5 }),
      ),
    ).toBe("Night out · Sat · home 01:00 · ½");
  });

  it("asks for the home time while a night needs one", () => {
    expect(
      healthChipText(
        healthTestNight({ day: "2026-10-09", needs_check: true, units: null }),
      ),
    ).toBe("Night out · Fri · home when?");
  });

  it("shows a bender without a time", () => {
    expect(
      healthChipText(
        healthTestNight({ day: "2026-10-09", bender: true, units: 1 }),
      ),
    ).toBe("Night out · Fri · bender · 1");
  });
});

describe("strip dots", () => {
  const entries = [
    healthTestEntry({ id: "a", day: "2026-10-12" }),
    healthTestNight({
      id: "b",
      day: "2026-10-10",
      units: 0.5,
      home_at: "01:30",
    }),
    healthTestNight({ id: "c", day: "2026-10-09", units: 1, home_at: "04:30" }),
    healthTestNight({
      id: "d",
      day: "2026-10-08",
      units: null,
      needs_check: true,
    }),
    healthTestNight({ id: "e", day: "2026-10-07", units: 0, home_at: "23:30" }),
  ];

  it("is empty when nothing happened", () => {
    expect(healthDotState(entries, "breath", "2026-10-12").state).toBe("none");
    expect(healthDotState(entries, "training", "2026-10-11").state).toBe(
      "none",
    );
  });

  it("fills a dot for something done", () => {
    expect(healthDotState(entries, "training", "2026-10-12").state).toBe(
      "done",
    );
  });

  it("tells the nights apart", () => {
    expect(healthDotState(entries, "night_out", "2026-10-10").state).toBe(
      "half",
    );
    expect(healthDotState(entries, "night_out", "2026-10-09").state).toBe(
      "done",
    );
    expect(healthDotState(entries, "night_out", "2026-10-08").state).toBe(
      "check",
    );
    expect(healthDotState(entries, "night_out", "2026-10-07").state).toBe(
      "zero",
    );
  });

  it("lists seven days and marks today", () => {
    const days = healthStripDays("2026-10-06", "2026-10-12");
    expect(days.map((d) => d.day)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    expect(days.filter((d) => d.isToday).map((d) => d.day)).toEqual([
      "2026-10-12",
    ]);
  });
});

describe("the year grid", () => {
  it("makes whole weeks, Monday first, and marks the future", () => {
    const weeks = healthYearWeeks(2026, [], "2026-10-13");
    // 2026-01-01 is a Thursday, so the first column is Monday 29 Dec 2025.
    expect(weeks[0]?.start).toBe("2025-12-29");
    expect(weeks.at(-1)?.start).toBe("2026-12-28");
    expect(weeks).toHaveLength(53);
    expect(weeks.find((w) => w.start === "2026-10-12")?.future).toBe(false);
    expect(weeks.find((w) => w.start === "2026-10-19")?.future).toBe(true);
  });

  it("adds each day to its week", () => {
    const weeks = healthYearWeeks(
      2026,
      [
        { day: "2026-10-12", training: 1, breath: 1, night_out: null },
        { day: "2026-10-14", training: 1, breath: 2, night_out: 0.5 },
        { day: "2026-10-17", training: 0, breath: 0, night_out: 1 },
      ],
      "2026-10-18",
    );
    const week = weeks.find((w) => w.start === "2026-10-12");
    expect(week).toMatchObject({ training: 2, breath: 2, out: 1.5 });
  });

  it("puts a month name over the week it starts in", () => {
    const marks = healthMonthMarks(healthYearWeeks(2026, [], "2026-10-13"));
    expect(marks.map((m) => m.label)).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]);
  });

  it("grades a value against a full week", () => {
    expect(healthLevel(0, 3)).toBe(0);
    expect(healthLevel(1, 3)).toBe(2);
    expect(healthLevel(2, 3)).toBe(3);
    expect(healthLevel(3, 3)).toBe(4);
    expect(healthLevel(5, 3)).toBe(4);
  });

  it("caps a share for a bar", () => {
    expect(healthShare(1, 4)).toBe(0.25);
    expect(healthShare(9, 4)).toBe(1);
    expect(healthShare(0, 0)).toBe(0);
    expect(healthShare(1, 0)).toBe(1);
  });
});
