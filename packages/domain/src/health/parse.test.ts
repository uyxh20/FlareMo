import { healthLocalMoment, healthNightUnitsFor } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  type HealthParsedEntry,
  healthMemoIsSkipped,
  healthParseMemo,
  healthStripTimestampPrefix,
} from "./parse";

// The diary reader's spec (docs/fork-health-tracker.md). Every case is an
// invented diary line. Times are written as the owner's local wall clock
// (Europe/Copenhagen, UTC+2 until 25 October 2026); `at` turns them into the
// UTC `created_at` the parser receives.
//
// The calendar the cases use (2026):
//   Mon 5 Oct, Tue 6, Wed 7, Thu 8, Fri 9, Sat 10, Sun 11, Mon 12, Tue 13, Wed 14

function at(local: string, offset = "+02:00"): string {
  return new Date(`${local.replace(" ", "T")}:00${offset}`).toISOString();
}

type Partial = Partial_<HealthParsedEntry>;
type Partial_<T> = { [K in keyof T]?: T[K] };

const BLANK = {
  variant: null,
  minutes: null,
  homeAt: null,
  units: null,
  bender: false,
  needsCheck: false,
  feel: null,
} as const;

function training(
  day: string,
  variant: HealthParsedEntry["variant"],
  extra: Partial = {},
): HealthParsedEntry {
  return { ...BLANK, kind: "training", day, variant, ...extra };
}

function breath(
  day: string,
  variant: HealthParsedEntry["variant"],
  minutes: number,
  extra: Partial = {},
): HealthParsedEntry {
  return { ...BLANK, kind: "breath", day, variant, minutes, ...extra };
}

function night(
  day: string,
  extra: Partial & { homeAt: string | null },
): HealthParsedEntry {
  return {
    ...BLANK,
    kind: "night_out",
    day,
    units: null,
    needsCheck: false,
    ...extra,
  };
}

type Case = {
  name: string;
  /** Local wall clock the memo was written. */
  when: string;
  content: string;
  expected: HealthParsedEntry[];
  tags?: string[];
  source?: string;
};

const WED_EVENING = "2026-10-14 20:00";
const TUE_EVENING = "2026-10-13 19:30";

const CASES: Case[] = [
  // --- Training: what counts ------------------------------------------------
  {
    name: "a tagged back day",
    when: TUE_EVENING,
    content: "#gym back day done",
    expected: [training("2026-10-13", "back")],
  },
  {
    name: "crossfit, capitalised",
    when: TUE_EVENING,
    content: "CrossFit done",
    expected: [training("2026-10-13", "crossfit")],
  },
  {
    name: "cross fit as two words",
    when: TUE_EVENING,
    content: "cross fit done",
    expected: [training("2026-10-13", "crossfit")],
  },
  {
    name: "bench press means chest",
    when: TUE_EVENING,
    content: "bench press day gym done",
    expected: [training("2026-10-13", "chest")],
  },
  {
    name: "zone 2 on the bike is cardio with minutes",
    when: TUE_EVENING,
    content: "zone 2 bike 20 mins",
    expected: [training("2026-10-13", "cardio", { minutes: 20 })],
  },
  {
    name: "the bare tag is an unspecified gym session",
    when: TUE_EVENING,
    content: "#gym",
    expected: [training("2026-10-13", "gym")],
  },
  {
    name: "gym done",
    when: TUE_EVENING,
    content: "gym done",
    expected: [training("2026-10-13", "gym")],
  },
  {
    name: "went to the gym",
    when: TUE_EVENING,
    content: "went to the gym after work",
    expected: [training("2026-10-13", "gym")],
  },
  {
    name: "leg day",
    when: TUE_EVENING,
    content: "leg day done",
    expected: [training("2026-10-13", "legs")],
  },
  {
    name: "push day with a feeling",
    when: TUE_EVENING,
    content: "push day gym done, felt great",
    expected: [training("2026-10-13", "push", { feel: "great" })],
  },
  {
    name: "pull day, the feeling skips filler words",
    when: TUE_EVENING,
    content: "Pull day done. Feeling a bit tired",
    expected: [training("2026-10-13", "pull", { feel: "tired" })],
  },
  {
    name: "chest day",
    when: TUE_EVENING,
    content: "chest day done",
    expected: [training("2026-10-13", "chest")],
  },
  {
    name: "upper day with the tag after it",
    when: TUE_EVENING,
    content: "upper day #gym",
    expected: [training("2026-10-13", "upper")],
  },
  {
    name: "a split written next to the word gym",
    when: TUE_EVENING,
    content: "gym back done",
    expected: [training("2026-10-13", "back")],
  },
  {
    name: "deadlifts are an unspecified session",
    when: TUE_EVENING,
    content: "deadlift 5x5 done",
    expected: [training("2026-10-13", "gym")],
  },
  {
    name: "a run with a distance is cardio",
    when: TUE_EVENING,
    content: "ran 5k",
    expected: [training("2026-10-13", "cardio")],
  },
  {
    name: "a run with minutes",
    when: TUE_EVENING,
    content: "run 30 mins",
    expected: [training("2026-10-13", "cardio", { minutes: 30 })],
  },
  {
    name: "the strongest variant wins when a memo names several",
    when: TUE_EVENING,
    content: "#gym, chest day done, zone 2 bike 10 mins",
    expected: [training("2026-10-13", "chest")],
  },

  // --- Training: what does not count -----------------------------------------
  {
    name: "a plan for this morning",
    when: "2026-10-13 07:00",
    content: "this morning it's gym",
    expected: [],
  },
  {
    name: "no gym logged",
    when: TUE_EVENING,
    content: "no gym logged",
    expected: [],
  },
  {
    name: "gym tomorrow",
    when: TUE_EVENING,
    content: "gym tomorrow",
    expected: [],
  },
  {
    name: "going to the gym later",
    when: TUE_EVENING,
    content: "going to the gym later today",
    expected: [],
  },
  {
    name: "a skipped session",
    when: TUE_EVENING,
    content: "skipped the gym",
    expected: [],
  },
  {
    name: "a negated crossfit",
    when: TUE_EVENING,
    content: "didn't do crossfit",
    expected: [],
  },
  {
    name: "gym as the topic of a sentence",
    when: TUE_EVENING,
    content: "the gym is closed for the holiday",
    expected: [],
  },
  {
    name: "ran out of something",
    when: TUE_EVENING,
    content: "ran out of milk",
    expected: [],
  },
  {
    name: "a bike that is not a session",
    when: TUE_EVENING,
    content: "my bike needs a new chain",
    expected: [],
  },
  {
    name: "a bench in the park",
    when: TUE_EVENING,
    content: "sat on the bench in the park",
    expected: [],
  },
  {
    name: "back home from the pub",
    when: TUE_EVENING,
    content: "back home from the pub",
    expected: [],
  },

  // --- Breath -----------------------------------------------------------------
  {
    name: "wim hof with a bare number",
    when: "2026-10-13 08:00",
    content: "wim hof 10",
    expected: [breath("2026-10-13", "wim_hof", 10)],
  },
  {
    name: "tagged wimhof with minutes, done, and a feeling",
    when: "2026-10-13 08:00",
    content: "#wimhof 10 mins done. Feel better",
    expected: [breath("2026-10-13", "wim_hof", 10, { feel: "better" })],
  },
  {
    name: "WH as a word",
    when: "2026-10-13 08:00",
    content: "WH 15 minutes",
    expected: [breath("2026-10-13", "wim_hof", 15)],
  },
  {
    name: "wim hof with no number defaults to ten minutes",
    when: "2026-10-13 08:00",
    content: "wim hof",
    expected: [breath("2026-10-13", "wim_hof", 10)],
  },
  {
    name: "minutes glued to the number",
    when: "2026-10-13 08:00",
    content: "wimhof 5min",
    expected: [breath("2026-10-13", "wim_hof", 5)],
  },
  {
    name: "meditation with minutes",
    when: "2026-10-13 08:00",
    content: "meditation 20 mins",
    expected: [breath("2026-10-13", "meditation", 20)],
  },
  {
    name: "meditated for",
    when: "2026-10-13 08:00",
    content: "meditated for 15 minutes",
    expected: [breath("2026-10-13", "meditation", 15)],
  },
  {
    name: "breathwork counts as meditation",
    when: "2026-10-13 08:00",
    content: "breathwork 12 mins done",
    expected: [breath("2026-10-13", "meditation", 12)],
  },
  {
    name: "the meditation tag alone",
    when: "2026-10-13 08:00",
    content: "#meditation",
    expected: [breath("2026-10-13", "meditation", 10)],
  },
  {
    name: "the word who is not WH",
    when: "2026-10-13 08:00",
    content: "who knows",
    expected: [],
  },
  {
    name: "a negated session",
    when: "2026-10-13 08:00",
    content: "wim hof not today",
    expected: [],
  },
  {
    name: "a plan",
    when: "2026-10-13 08:00",
    content: "should do wim hof tomorrow",
    expected: [],
  },
  {
    name: "a remark about wim hof is not a session",
    when: "2026-10-13 08:00",
    content: "wim hof helps me sleep a lot better",
    expected: [],
  },
  {
    name: "wim hof outside the gym is breath only",
    when: "2026-10-13 08:00",
    content: "wim hof outside gym",
    expected: [breath("2026-10-13", "wim_hof", 10)],
  },
  {
    name: "wim hof before gym is breath only",
    when: "2026-10-13 08:00",
    content: "wim hof 10 mins before gym",
    expected: [breath("2026-10-13", "wim_hof", 10)],
  },
  {
    name: "wim hof after gym is breath only, even with a done word",
    when: "2026-10-13 18:00",
    content: "after gym wim hof 15 done",
    expected: [breath("2026-10-13", "wim_hof", 15)],
  },
  {
    name: "a session and a place together are two rows",
    when: "2026-10-13 18:00",
    content: "wim hof 10 at the gym then bench press",
    expected: [
      training("2026-10-13", "chest"),
      breath("2026-10-13", "wim_hof", 10),
    ],
  },
  {
    name: "one memo, two kinds",
    when: TUE_EVENING,
    content: "crossfit done, wim hof 10",
    expected: [
      training("2026-10-13", "crossfit"),
      breath("2026-10-13", "wim_hof", 10),
    ],
  },

  // --- Nights out: home time and units -----------------------------------------
  {
    name: "til a four digit time, a weekday and a memo written days later",
    when: "2026-10-12 10:00",
    content: "went out Friday til 0330",
    expected: [night("2026-10-09", { homeAt: "03:30", units: 1 })],
  },
  {
    name: "a bender over two days",
    when: "2026-10-08 11:00",
    content: "bender on Wed into Thu morning",
    expected: [night("2026-10-07", { homeAt: null, units: 1, bender: true })],
  },
  {
    name: "last week, with the named day not yet this week",
    when: "2026-10-12 09:00",
    content: "last week bender wed til thu",
    expected: [night("2026-10-07", { homeAt: null, units: 1, bender: true })],
  },
  {
    name: "last week on the same weekday goes back seven days",
    when: WED_EVENING,
    content: "last week bender wed til thu",
    expected: [night("2026-10-07", { homeAt: null, units: 1, bender: true })],
  },
  {
    name: "a weekday on the entry's own weekday means that day",
    when: WED_EVENING,
    content: "went out wed til 3",
    expected: [night("2026-10-14", { homeAt: "03:00", units: 1 })],
  },
  {
    name: "til 5am",
    when: "2026-10-10 10:00",
    content: "went out til 5am",
    expected: [night("2026-10-09", { homeAt: "05:00", units: 1 })],
  },
  {
    name: "no day word and written after 14:00 is the same day",
    when: "2026-10-10 16:00",
    content: "went out til 5am",
    expected: [night("2026-10-10", { homeAt: "05:00", units: 1 })],
  },
  {
    name: "home at 2 is half a unit",
    when: "2026-10-11 09:00",
    content: "night out, home at 2",
    expected: [night("2026-10-10", { homeAt: "02:00", units: 0.5 })],
  },
  {
    name: "home by 5am",
    when: "2026-10-11 09:00",
    content: "night out home by 5am",
    expected: [night("2026-10-10", { homeAt: "05:00", units: 1 })],
  },
  {
    name: "a bare 11 after home by means 23:00, before midnight, zero",
    when: "2026-10-10 15:00",
    content: "went out, home by 11",
    expected: [night("2026-10-10", { homeAt: "23:00", units: 0 })],
  },
  {
    name: "til 7 means 19:00",
    when: "2026-10-10 15:00",
    content: "went out Fri til 7",
    expected: [night("2026-10-09", { homeAt: "19:00", units: 0 })],
  },
  {
    name: "11:30pm is a social evening",
    when: "2026-10-10 15:00",
    content: "went out til 11:30pm",
    expected: [night("2026-10-10", { homeAt: "23:30", units: 0 })],
  },
  {
    name: "a bare 12 is midnight",
    when: "2026-10-11 10:00",
    content: "party until 12",
    expected: [night("2026-10-10", { homeAt: "00:00", units: 0.5 })],
  },
  {
    name: "06:00 or later is a bender",
    when: "2026-10-11 12:00",
    content: "went out yesterday til 6am",
    expected: [
      night("2026-10-10", { homeAt: "06:00", units: 1, bender: true }),
    ],
  },
  {
    name: "8am is a bender",
    when: "2026-10-12 12:00",
    content: "went out Sat til 8am",
    expected: [
      night("2026-10-10", { homeAt: "08:00", units: 1, bender: true }),
    ],
  },
  {
    name: "an arrow before the hour",
    when: "2026-10-11 12:00",
    content: "clubbing last night -> 4",
    expected: [night("2026-10-10", { homeAt: "04:00", units: 1 })],
  },
  {
    name: "a unicode arrow",
    when: "2026-10-11 12:00",
    content: "clubbing last night → 4",
    expected: [night("2026-10-10", { homeAt: "04:00", units: 1 })],
  },
  {
    name: "til with a colon and a weak keyword",
    when: "2026-10-12 12:00",
    content: "rave saturday till 3:30",
    expected: [night("2026-10-10", { homeAt: "03:30", units: 1 })],
  },
  {
    name: "a dotted time",
    when: "2026-10-12 12:00",
    content: "went out saturday til 3.30",
    expected: [night("2026-10-10", { homeAt: "03:30", units: 1 })],
  },
  {
    name: "a curly-apostrophe 'til",
    when: "2026-10-12 12:00",
    content: "out drinking Saturday ’til 4",
    expected: [night("2026-10-10", { homeAt: "04:00", units: 1 })],
  },
  {
    name: "not sleeping makes a bender with no home time",
    when: "2026-10-12 12:00",
    content: "didn't sleep after the party Friday",
    expected: [night("2026-10-09", { homeAt: null, units: 1, bender: true })],
  },
  {
    name: "tonight is the entry's day",
    when: "2026-10-09 21:00",
    content: "went out tonight til 1",
    expected: [night("2026-10-09", { homeAt: "01:00", units: 0.5 })],
  },
  {
    name: "the bare tag waits for a home time",
    when: "2026-10-10 15:00",
    content: "#out",
    expected: [
      night("2026-10-10", { homeAt: null, units: null, needsCheck: true }),
    ],
  },
  {
    name: "a night with no time and no bender needs a check",
    when: "2026-10-11 11:00",
    content: "went out Saturday",
    expected: [
      night("2026-10-10", { homeAt: null, units: null, needsCheck: true }),
    ],
  },
  {
    name: "the word bender alone is one unit",
    when: "2026-10-11 11:00",
    content: "bender",
    expected: [night("2026-10-10", { homeAt: null, units: 1, bender: true })],
  },
  {
    name: "the latest of two home times wins",
    when: "2026-10-12 11:00",
    content: "went out Friday, home at 2 then out again til 5",
    expected: [night("2026-10-09", { homeAt: "05:00", units: 1 })],
  },
  {
    name: "a night in another town is still a night out",
    when: "2026-10-12 11:00",
    content: "festival in Berlin on Saturday til 4am",
    expected: [night("2026-10-10", { homeAt: "04:00", units: 1 })],
  },

  // --- Nights out: what does not count ------------------------------------------
  {
    name: "a book club",
    when: TUE_EVENING,
    content: "book club tonight",
    expected: [],
  },
  {
    name: "party planning",
    when: TUE_EVENING,
    content: "party planning meeting",
    expected: [],
  },
  {
    name: "a plan to go to a rave",
    when: TUE_EVENING,
    content: "going to a rave Saturday til late",
    expected: [],
  },
  {
    name: "festival tickets",
    when: TUE_EVENING,
    content: "bought festival tickets",
    expected: [],
  },
  {
    name: "a negated night out",
    when: TUE_EVENING,
    content: "no night out this week",
    expected: [],
  },
  {
    name: "a film review",
    when: TUE_EVENING,
    content: "rave review of the new film",
    expected: [],
  },
  {
    name: "a club sandwich",
    when: TUE_EVENING,
    content: "club sandwich for lunch",
    expected: [],
  },

  // --- Mixed ---------------------------------------------------------------------
  {
    name: "training, breath and a night in one memo",
    when: "2026-10-10 10:00",
    content: "crossfit done, wim hof 10, went out Fri til 2",
    expected: [
      training("2026-10-10", "crossfit"),
      breath("2026-10-10", "wim_hof", 10),
      night("2026-10-09", { homeAt: "02:00", units: 0.5 }),
    ],
  },

  // --- Days of sessions ------------------------------------------------------------
  {
    name: "yesterday moves a session back",
    when: "2026-10-13 09:00",
    content: "wim hof 10 yesterday",
    expected: [breath("2026-10-12", "wim_hof", 10)],
  },
  {
    name: "crossfit yesterday",
    when: "2026-10-13 09:00",
    content: "crossfit yesterday",
    expected: [training("2026-10-12", "crossfit")],
  },
  {
    name: "a weekday with forgot to log",
    when: "2026-10-09 09:00",
    content: "forgot to log wed: crossfit done",
    expected: [training("2026-10-07", "crossfit")],
  },
  {
    name: "a session is the entry's local day, not the UTC day",
    when: "2026-10-13 01:30",
    content: "wim hof 10",
    expected: [breath("2026-10-13", "wim_hof", 10)],
  },
  {
    name: "winter time is one hour from UTC",
    when: "2026-12-01 23:30",
    content: "wim hof 10",
    expected: [breath("2026-12-01", "wim_hof", 10)],
  },

  // --- The import's timestamp prefix ----------------------------------------------------
  {
    name: "a bold timestamp prefix is stripped",
    when: "2026-09-19 08:23",
    content: "**2026-09-19 08:23:** wim hof 10",
    expected: [breath("2026-09-19", "wim_hof", 10)],
  },
  {
    name: "a prefix before a night out",
    when: "2026-09-20 09:10",
    content: "**2026-09-20 09:10:** went out Sat til 0400",
    expected: [night("2026-09-19", { homeAt: "04:00", units: 1 })],
  },
  {
    name: "a prefix does not make a plan a session",
    when: "2026-09-19 08:23",
    content: "**2026-09-19 08:23:** gym tomorrow",
    expected: [],
  },

  // --- Skipped memos --------------------------------------------------------------------
  {
    name: "a summary tag",
    when: TUE_EVENING,
    content: "#vault-summary crossfit done, wim hof 10",
    expected: [],
  },
  {
    name: "a seed tag passed with the memo",
    when: TUE_EVENING,
    content: "crossfit done",
    tags: ["seed"],
    expected: [],
  },
  {
    name: "a nested skip tag",
    when: TUE_EVENING,
    content: "crossfit done",
    tags: ["vault-tracker/health"],
    expected: [],
  },
  {
    name: "an agent memory",
    when: TUE_EVENING,
    content: "crossfit done",
    tags: ["agent-memory"],
    expected: [],
  },
  {
    name: "the weekly review's own memo",
    when: TUE_EVENING,
    content: "crossfit done, wim hof 10",
    source: "weekly-review",
    expected: [],
  },
  {
    name: "a memo over 1500 characters",
    when: TUE_EVENING,
    content: `crossfit done ${"x".repeat(1500)}`,
    expected: [],
  },

  // --- Long memos (300 to 1500 characters) ------------------------------------------------
  {
    name: "a long memo with only a mention of the gym",
    when: TUE_EVENING,
    content: `${"Thinking about the week and what to change. ".repeat(8)}The gym is a good place to start.`,
    expected: [],
  },
  {
    name: "a long memo with a gym tag counts",
    when: TUE_EVENING,
    content: `${"Thinking about the week and what to change. ".repeat(8)}#gym`,
    expected: [training("2026-10-13", "gym")],
  },
  {
    name: "a long memo with a done word near the keyword counts",
    when: TUE_EVENING,
    content: `${"Thinking about the week and what to change. ".repeat(8)}I did crossfit.`,
    expected: [training("2026-10-13", "crossfit")],
  },
  {
    name: "a long memo that plans a session does not count",
    when: "2026-10-13 07:00",
    content: `${"Thinking about the week and what to change. ".repeat(8)}This morning it's gym.`,
    expected: [],
  },
  {
    name: "a long memo that only says bender does not count",
    when: TUE_EVENING,
    content: `${"Thinking about the week and what to change. ".repeat(8)}Last week felt like a bender of a week.`,
    expected: [],
  },
  {
    name: "a long memo with a night out and a home time counts",
    when: "2026-10-10 11:00",
    content: `${"Thinking about the week and what to change. ".repeat(8)}Went out Fri til 3.`,
    expected: [night("2026-10-09", { homeAt: "03:00", units: 1 })],
  },
  {
    name: "a long memo with the wim hof tag counts",
    when: TUE_EVENING,
    content: `${"Thinking about the week and what to change. ".repeat(8)}#wimhof 12`,
    expected: [breath("2026-10-13", "wim_hof", 12)],
  },
];

describe("healthParseMemo", () => {
  it("has the 40+ cases the contract asks for", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES)("$name", (testCase) => {
    const parsed = healthParseMemo({
      content: testCase.content,
      createdAt: at(testCase.when),
      tags: testCase.tags,
      source: testCase.source,
    });
    expect(parsed).toEqual(testCase.expected);
  });

  it("is deterministic", () => {
    const input = {
      content: "crossfit done, wim hof 10, went out Fri til 2",
      createdAt: at("2026-10-10 10:00"),
    };
    expect(healthParseMemo(input)).toEqual(healthParseMemo(input));
  });

  it("returns nothing for an empty memo", () => {
    expect(
      healthParseMemo({ content: "  ", createdAt: at(TUE_EVENING) }),
    ).toEqual([]);
  });

  it("yields at most one entry per kind", () => {
    const parsed = healthParseMemo({
      content: "gym done. crossfit done. wim hof 10. meditation 20",
      createdAt: at(TUE_EVENING),
    });
    expect(parsed.map((entry) => entry.kind)).toEqual(["training", "breath"]);
  });
});

describe("healthStripTimestampPrefix", () => {
  it("removes the import's bold local timestamp only at the start", () => {
    expect(healthStripTimestampPrefix("**2026-09-19 08:23:** wim hof 10")).toBe(
      "wim hof 10",
    );
    expect(healthStripTimestampPrefix("wim hof **2026-09-19 08:23:**")).toBe(
      "wim hof **2026-09-19 08:23:**",
    );
  });
});

describe("healthMemoIsSkipped", () => {
  it("skips by tag, hashtag, source and length", () => {
    expect(healthMemoIsSkipped({ content: "x", tags: ["vault-theme"] })).toBe(
      true,
    );
    expect(healthMemoIsSkipped({ content: "x #vault-thinking" })).toBe(true);
    expect(healthMemoIsSkipped({ content: "x", source: "weekly-review" })).toBe(
      true,
    );
    expect(healthMemoIsSkipped({ content: "x".repeat(1501) })).toBe(true);
    expect(healthMemoIsSkipped({ content: "x", tags: ["gym"] })).toBe(false);
    expect(healthMemoIsSkipped({ content: "x".repeat(1500) })).toBe(false);
  });
});

describe("healthNightUnitsFor", () => {
  it.each([
    ["17:00", 0, false],
    ["23:59", 0, false],
    ["00:00", 0.5, false],
    ["02:59", 0.5, false],
    ["03:00", 1, false],
    ["05:59", 1, false],
    ["06:00", 1, true],
    ["12:30", 1, true],
  ])("%s counts %s (bender %s)", (homeAt, units, bender) => {
    expect(healthNightUnitsFor(homeAt)).toEqual({ units, bender });
  });

  it("rejects what is not HH:MM", () => {
    expect(healthNightUnitsFor("3:30")).toBeNull();
    expect(healthNightUnitsFor("24:00")).toBeNull();
    expect(healthNightUnitsFor("12:60")).toBeNull();
  });
});

describe("healthLocalMoment", () => {
  it("reads the Copenhagen wall clock, summer and winter", () => {
    expect(healthLocalMoment("2026-10-12T23:30:00.000Z")).toEqual({
      day: "2026-10-13",
      hour: 1,
      minute: 30,
    });
    expect(healthLocalMoment("2026-12-01T22:30:00.000Z")).toEqual({
      day: "2026-12-01",
      hour: 23,
      minute: 30,
    });
  });
});
