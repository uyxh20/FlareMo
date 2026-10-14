import type { HealthTrackerInput } from "@flaremo/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemo } from "../memos-write";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "../planner/test-support";
import { healthParseMemo } from "./parse";
import { healthReadWeek, healthReadYear, healthToday } from "./read";
import { healthPreviewTracker, healthRescan } from "./sync";
import {
  healthArchiveTracker,
  healthCreateTracker,
  healthListTrackers,
  healthSetBuiltinWords,
  healthTestTracker,
  healthUpdateTracker,
} from "./trackers";

// Trackers the owner edits in the app (fork-owned add-on,
// docs/fork-health-tracker.md, "Trackers"). Invented sentences only.

const FAST = {
  kind: "t:fast00000001" as const,
  measure: "hours" as const,
  words: ["#fast", "fasted", "fasting", "omad", "16:8"],
  blocked: ["breakfast"],
};

function parse(content: string, createdAt = "2026-10-14T10:00:00.000Z") {
  return healthParseMemo({ content, createdAt }, { trackers: [FAST] }).filter(
    (entry) => entry.kind === FAST.kind,
  );
}

describe("the reader with an owner's tracker", () => {
  it("counts a done sentence on the day written, with hours", () => {
    expect(parse("Fasted 18h, broke it at 2")).toEqual([
      expect.objectContaining({ day: "2026-10-14", minutes: 18 * 60 }),
    ]);
    expect(parse("#fast 16:8 again")[0]?.minutes).toBe(16 * 60);
    expect(parse("OMAD")[0]?.minutes).toBeNull();
  });

  it("moves the day back for yesterday", () => {
    expect(parse("Did OMAD yesterday")[0]?.day).toBe("2026-10-13");
  });

  it("skips plans, denials, other words and blocked words", () => {
    expect(parse("Tomorrow I'll start fasting")).toEqual([]);
    expect(parse("No fasting today, too hungry")).toEqual([]);
    expect(parse("Ran fast, felt great")).toEqual([]);
    expect(parse("Fasted till a late breakfast")).toEqual([]);
  });

  it("reads a memo tag as the tracker's hashtag", () => {
    expect(
      healthParseMemo(
        {
          content: "18 hours, easy",
          createdAt: "2026-10-14T10:00:00.000Z",
          tags: ["fast"],
        },
        { trackers: [FAST] },
      ),
    ).toEqual([expect.objectContaining({ kind: FAST.kind, minutes: 1080 })]);
  });

  it("adds a built-in's extra words without changing what it already reads", () => {
    const config = {
      builtins: { training: { words: ["hyrox"], blocked: ["gym bag"] } },
    };
    const read = (content: string) =>
      healthParseMemo(
        { content, createdAt: "2026-10-14T10:00:00.000Z" },
        config,
      ).map((entry) => [entry.kind, entry.variant]);
    expect(read("hyrox done")).toEqual([["training", null]]);
    expect(read("crossfit done")).toEqual([["training", "crossfit"]]);
    expect(read("crossfit done, forgot my gym bag")).toEqual([]);
    expect(read("hyrox tomorrow")).toEqual([]);
  });

  it("is the fixed reader when nothing is set", () => {
    const text = "crossfit done, wim hof 10, went out til 3";
    const at = "2026-10-14T10:00:00.000Z";
    expect(healthParseMemo({ content: text, createdAt: at }, {})).toEqual(
      healthParseMemo({ content: text, createdAt: at }),
    );
  });

  it("explains a test sentence", () => {
    const draft = { measure: "hours" as const, words: FAST.words, blocked: [] };
    expect(healthTestTracker({ text: "Fasted 16h", draft })).toEqual({
      reason: "counted",
      match: "fasted",
      day_offset: 0,
      minutes: 960,
    });
    expect(
      healthTestTracker({ text: "Going to try fasting tomorrow", draft })
        .reason,
    ).toBe("plan");
    expect(healthTestTracker({ text: "No fasting today", draft }).reason).toBe(
      "negated",
    );
    expect(healthTestTracker({ text: "Drove fast", draft }).reason).toBe(
      "no_word",
    );
  });
});

describe("health trackers", () => {
  let rt: PlannerTestRuntime;
  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-health-trackers");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      [
        "health_tracker_event",
        "health_tracker",
        "health_entry_event",
        "health_entry",
        "health_sync_state",
        "memos",
      ].map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
    );
  });

  const fasting: HealthTrackerInput = {
    label: "Fasting",
    color: "green",
    measure: "hours",
    words: ["#fast", "fasted", "omad"],
    blocked: [],
    goal_id: null,
  };

  async function write(content: string) {
    return createMemo(rt.db, rt.user, {
      content,
      visibility: "private",
      source: "web",
    });
  }

  const live = () =>
    plannerTestRows<{ kind: string; minutes: number | null }>(
      rt.database,
      "SELECT kind, minutes FROM health_entry WHERE deleted_at IS NULL ORDER BY kind",
    );

  it("lists the built-ins first, then the owner's trackers", async () => {
    await healthCreateTracker(rt.db, { userId: rt.user.id, tracker: fasting });
    const list = await healthListTrackers(rt.db, rt.user.id);
    expect(list.map((tracker) => [tracker.id, tracker.builtin])).toEqual([
      ["training", true],
      ["breath", true],
      ["night_out", true],
      [list[3]?.id, false],
    ]);
    expect(list[3]?.kind).toBe(`t:${list[3]?.id}`);
  });

  it("reads saved memos with a new tracker, previews and re-reads on change", async () => {
    const created = await healthCreateTracker(rt.db, {
      userId: rt.user.id,
      tracker: fasting,
    });
    await write("Fasted 18h");
    await write("OMAD, felt sharp");
    await write("crossfit done");
    expect(await live()).toEqual([
      { kind: created.kind, minutes: 1080 },
      { kind: created.kind, minutes: null },
      { kind: "training", minutes: null },
    ]);

    const preview = await healthPreviewTracker(rt.db, {
      userId: rt.user.id,
      draft: {
        id: created.id,
        measure: "hours",
        words: ["fasted", "crossfit"],
        blocked: [],
      },
    });
    expect(preview).toMatchObject({
      added: 1,
      removed: 1,
      unchanged: 1,
      memos: 3,
    });
    expect(preview.added_days).toEqual([healthToday()]);
    // A preview writes nothing.
    expect(await live()).toHaveLength(3);

    await healthUpdateTracker(rt.db, {
      userId: rt.user.id,
      id: created.id,
      tracker: { ...fasting, words: ["fasted"] },
    });
    expect(await healthRescan(rt.db, rt.user.id)).toMatchObject({
      removed: 1,
    });

    const week = await healthReadWeek(rt.db, { userId: rt.user.id });
    expect(week.trackers).toEqual([
      { kind: created.kind, days: 1, minutes: 1080 },
    ]);
    const year = await healthReadYear(rt.db, { userId: rt.user.id });
    expect(year.trackers).toEqual([
      { kind: created.kind, days: 1, minutes: 1080 },
    ]);
    expect(
      year.days.find((day) => day.day === healthToday())?.trackers,
    ).toEqual({ [created.kind]: 1 });
  });

  it("archives a tracker: its rows are hidden, never deleted, and history is kept", async () => {
    const created = await healthCreateTracker(rt.db, {
      userId: rt.user.id,
      tracker: fasting,
    });
    await write("Fasted 18h");
    await healthArchiveTracker(rt.db, { userId: rt.user.id, id: created.id });
    await healthRescan(rt.db, rt.user.id);
    expect(await live()).toEqual([]);
    const all = await plannerTestRows(
      rt.database,
      "SELECT id FROM health_entry",
    );
    expect(all).toHaveLength(1);
    const events = await plannerTestRows<{ action: string }>(
      rt.database,
      "SELECT action FROM health_tracker_event ORDER BY at, rowid",
    );
    expect(events.map((event) => event.action)).toEqual(["create", "archive"]);
    expect(
      (await healthListTrackers(rt.db, rt.user.id)).map((t) => t.id),
    ).toEqual(["training", "breath", "night_out"]);
    const week = await healthReadWeek(rt.db, { userId: rt.user.id });
    expect(week.trackers).toEqual([]);
  });

  it("stores a built-in's extra words and reads with them", async () => {
    await healthSetBuiltinWords(rt.db, {
      userId: rt.user.id,
      kind: "training",
      words: { words: ["hyrox"], blocked: [] },
    });
    await write("hyrox done");
    expect(await live()).toEqual([{ kind: "training", minutes: null }]);
    const list = await healthListTrackers(rt.db, rt.user.id);
    expect(list[0]).toMatchObject({
      id: "training",
      words: ["hyrox"],
      builtin: true,
    });
  });

  it("rejects a goal that does not exist and a word that is also blocked", async () => {
    await expect(
      healthCreateTracker(rt.db, {
        userId: rt.user.id,
        tracker: { ...fasting, goal_id: "nope" },
      }),
    ).rejects.toThrow(/goal/);
    await expect(
      healthCreateTracker(rt.db, {
        userId: rt.user.id,
        tracker: { ...fasting, blocked: ["omad"] },
      }),
    ).rejects.toThrow(/blocked/);
  });

  it("leaves the weekly review's entries to the built-in kinds", async () => {
    await healthCreateTracker(rt.db, { userId: rt.user.id, tracker: fasting });
    await write("Fasted 18h, crossfit done");
    const { plannerReadWeekHealth } = await import("../planner/review-context");
    const today = healthToday();
    const week = await plannerReadWeekHealth(rt.db, {
      userId: rt.user.id,
      weekStart: today,
    });
    expect(week.entries.map((entry) => entry.kind)).toEqual(["training"]);
  });
});
