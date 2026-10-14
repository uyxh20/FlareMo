import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../errors";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "../planner/test-support";
import {
  healthReadMemos,
  healthReadTargets,
  healthReadWeek,
  healthReadYear,
} from "./read";
import { healthDismissEntry, healthPatchEntry } from "./write";

// Reading and fixing health rows against a real D1 (fork-owned add-on,
// docs/fork-health-tracker.md). "Now" is fixed to Tue 13 Oct 2026, noon local.

const NOW = new Date("2026-10-13T10:00:00.000Z");

type Seed = {
  id: string;
  kind: "training" | "breath" | "night_out";
  day: string;
  variant?: string | null;
  minutes?: number | null;
  homeAt?: string | null;
  units?: number | null;
  bender?: boolean;
  needsCheck?: boolean;
  memoId?: string | null;
  dismissed?: boolean;
  deletedAt?: string | null;
  userId?: string;
};

describe("health read and write", () => {
  let rt: PlannerTestRuntime;
  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-health-read-write");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.database.batch(
      ["health_entry_event", "health_entry", "health_target"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  // No route sets targets any more; a row the owner might still hold is
  // written straight into the table.
  async function setTarget(
    kind: "training" | "breath" | "night_out",
    period: "week" | "year",
    amount: number,
  ) {
    await plannerTestRun(
      rt.database,
      `INSERT INTO health_target (user_id, kind, period, amount, updated_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind, period)
         DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
      rt.user.id,
      kind,
      period,
      amount,
      NOW.toISOString(),
    );
  }

  async function seed(...entries: Seed[]) {
    for (const entry of entries) {
      await plannerTestRun(
        rt.database,
        `INSERT INTO health_entry
           (id, user_id, kind, day, variant, minutes, home_at, units, bender, needs_check,
            source, memo_id, dismissed, edited, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'memo', ?, ?, 0, ?, ?, ?)`,
        entry.id,
        entry.userId ?? rt.user.id,
        entry.kind,
        entry.day,
        entry.variant ?? null,
        entry.minutes ?? null,
        entry.homeAt ?? null,
        entry.units ?? null,
        entry.bender ? 1 : 0,
        entry.needsCheck ? 1 : 0,
        entry.memoId ?? null,
        entry.dismissed ? 1 : 0,
        `2026-10-13T08:00:00.000Z`,
        `2026-10-13T08:00:00.000Z`,
        entry.deletedAt ?? null,
      );
    }
  }

  const events = () =>
    plannerTestRows<{
      action: string;
      before_json: string;
      after_json: string;
    }>(rt.database, "SELECT * FROM health_entry_event ORDER BY at, rowid");

  describe("the week", () => {
    it("lists seven days and sums them against the targets", async () => {
      await seed(
        { id: "t1", kind: "training", day: "2026-10-07", variant: "back" },
        { id: "t2", kind: "training", day: "2026-10-13", variant: "gym" },
        { id: "b1", kind: "breath", day: "2026-10-13", minutes: 10 },
        { id: "b2", kind: "breath", day: "2026-10-13", minutes: 5 },
        { id: "b3", kind: "breath", day: "2026-10-12", minutes: 10 },
        {
          id: "n1",
          kind: "night_out",
          day: "2026-10-09",
          homeAt: "03:30",
          units: 1,
        },
        {
          id: "n2",
          kind: "night_out",
          day: "2026-10-10",
          units: null,
          needsCheck: true,
        },
        // Outside the window, dismissed, deleted and someone else's.
        { id: "old", kind: "training", day: "2026-10-06" },
        { id: "dis", kind: "training", day: "2026-10-12", dismissed: true },
        {
          id: "del",
          kind: "training",
          day: "2026-10-12",
          deletedAt: "2026-10-13T09:00:00.000Z",
        },
        { id: "other", kind: "training", day: "2026-10-12", userId: "someone" },
      );
      const week = await healthReadWeek(rt.db, {
        userId: rt.user.id,
        now: NOW,
      });
      expect(week.start).toBe("2026-10-07");
      expect(week.end).toBe("2026-10-13");
      expect(week.today).toBe("2026-10-13");
      expect(week.entries.map((entry) => entry.id)).toEqual([
        "t1",
        "n1",
        "n2",
        "b3",
        "t2",
        "b1",
        "b2",
      ]);
      expect(week.summary).toEqual({
        training: { sessions: 2, target: 3 },
        breath: { days: 2, sessions: 3, minutes: 25, target: 7 },
        night_out: {
          units: 1,
          nights: 2,
          needs_check: 1,
          year_target: 12,
          year_used: 1,
        },
      });
    });

    it("takes a start day, and the owner's own targets", async () => {
      await seed({ id: "t1", kind: "training", day: "2026-10-05" });
      await setTarget("training", "week", 4);
      const week = await healthReadWeek(rt.db, {
        userId: rt.user.id,
        start: "2026-10-05",
        now: NOW,
      });
      expect(week.entries).toHaveLength(1);
      expect(week.summary.training).toEqual({ sessions: 1, target: 4 });
    });
  });

  describe("the year", () => {
    it("aggregates per day and works out the pace", async () => {
      await seed(
        { id: "t1", kind: "training", day: "2026-01-02" },
        { id: "t2", kind: "training", day: "2026-01-02" },
        { id: "b1", kind: "breath", day: "2026-01-02", minutes: 10 },
        { id: "n1", kind: "night_out", day: "2026-03-07", units: 0.5 },
        {
          id: "n2",
          kind: "night_out",
          day: "2026-10-09",
          units: 1,
          bender: true,
        },
        { id: "n3", kind: "night_out", day: "2026-10-10", needsCheck: true },
        { id: "n4", kind: "night_out", day: "2026-10-11", units: 0 },
        { id: "last", kind: "training", day: "2025-12-31" },
      );
      const year = await healthReadYear(rt.db, {
        userId: rt.user.id,
        year: 2026,
        now: NOW,
      });
      expect(year.days.find((day) => day.day === "2026-01-02")).toEqual({
        day: "2026-01-02",
        training: 2,
        breath: 1,
        night_out: null,
        trackers: {},
      });
      expect(year.days.find((day) => day.day === "2026-10-10")).toMatchObject({
        night_out: null,
      });
      expect(year.days.find((day) => day.day === "2026-10-11")).toMatchObject({
        night_out: 0,
      });
      expect(year.night_out).toEqual({
        used: 1.5,
        target: 12,
        days_elapsed: 286,
        pace: 1.9,
        nights: 4,
        benders: 1,
        needs_check: 1,
      });
      expect(year.totals).toEqual({ training: 2, breath_days: 1 });
      expect(year.needs_check_entries.map((entry) => entry.id)).toEqual(["n3"]);
    });

    it("counts a finished year in full", async () => {
      await seed({ id: "n", kind: "night_out", day: "2025-05-05", units: 1 });
      const year = await healthReadYear(rt.db, {
        userId: rt.user.id,
        year: 2025,
        now: NOW,
      });
      expect(year.night_out.days_elapsed).toBe(365);
      expect(year.night_out.pace).toBe(1);
    });
  });

  describe("memos", () => {
    it("answers for bare and namespaced ids, and for memos with none", async () => {
      await seed(
        { id: "a", kind: "training", day: "2026-10-13", memoId: "memos/one" },
        { id: "b", kind: "breath", day: "2026-10-13", memoId: "memos/one" },
        { id: "c", kind: "training", day: "2026-10-13", memoId: "memos/two" },
        {
          id: "d",
          kind: "training",
          day: "2026-10-13",
          memoId: "memos/three",
          dismissed: true,
        },
      );
      const found = await healthReadMemos(rt.db, {
        userId: rt.user.id,
        ids: ["memos/one", "two", "memos/three", "memos/none"],
      });
      expect(found["memos/one"]?.map((entry) => entry.id)).toEqual(["a", "b"]);
      expect(found.two?.map((entry) => entry.id)).toEqual(["c"]);
      expect(found["memos/three"]).toEqual([]);
      expect(found["memos/none"]).toEqual([]);
    });

    it("reads a hundred ids", async () => {
      const ids = Array.from({ length: 100 }, (_, index) => `memos/m${index}`);
      await seed({
        id: "x",
        kind: "training",
        day: "2026-10-13",
        memoId: "memos/m99",
      });
      const found = await healthReadMemos(rt.db, { userId: rt.user.id, ids });
      expect(Object.keys(found)).toHaveLength(100);
      expect(found["memos/m99"]).toHaveLength(1);
    });

    it("does not show another user's entries", async () => {
      await seed({
        id: "x",
        kind: "training",
        day: "2026-10-13",
        memoId: "memos/m",
        userId: "someone",
      });
      const found = await healthReadMemos(rt.db, {
        userId: rt.user.id,
        ids: ["memos/m"],
      });
      expect(found["memos/m"]).toEqual([]);
    });
  });

  describe("targets", () => {
    it("starts at the defaults and reads what the owner saved", async () => {
      expect(await healthReadTargets(rt.db, rt.user.id)).toEqual([
        { kind: "training", period: "week", amount: 3, is_default: true },
        { kind: "breath", period: "week", amount: 7, is_default: true },
        { kind: "night_out", period: "year", amount: 12, is_default: true },
      ]);
      await setTarget("night_out", "year", 10);
      await setTarget("night_out", "year", 8);
      const targets = await healthReadTargets(rt.db, rt.user.id);
      expect(targets.find((t) => t.kind === "night_out")).toEqual({
        kind: "night_out",
        period: "year",
        amount: 8,
        is_default: false,
      });
      expect(targets.find((t) => t.kind === "training")?.is_default).toBe(true);
    });
  });

  describe("fixing a row", () => {
    const patch = (
      entryId: string,
      body: Parameters<typeof healthPatchEntry>[1]["patch"],
    ) => healthPatchEntry(rt.db, { userId: rt.user.id, entryId, patch: body });

    beforeEach(async () => {
      await seed(
        {
          id: "night",
          kind: "night_out",
          day: "2026-10-10",
          needsCheck: true,
          units: null,
        },
        { id: "gym", kind: "training", day: "2026-10-13", variant: "gym" },
        { id: "wh", kind: "breath", day: "2026-10-13", variant: "wim_hof" },
      );
    });

    it.each([
      ["23:30", 0, false],
      ["01:30", 0.5, false],
      ["04:30", 1, false],
      ["08:00", 1, true],
    ])("home %s counts %s (bender %s)", async (homeAt, units, bender) => {
      const entry = await patch("night", { home_at: homeAt });
      expect(entry).toMatchObject({
        home_at: homeAt,
        units,
        bender,
        needs_check: false,
      });
    });

    it("asks again when the home time is cleared", async () => {
      await patch("night", { home_at: "01:30" });
      const entry = await patch("night", { home_at: null });
      expect(entry).toMatchObject({
        home_at: null,
        units: null,
        needs_check: true,
      });
    });

    it("keeps a bender a bender when the time is cleared", async () => {
      await patch("night", { home_at: "08:00" });
      const entry = await patch("night", { home_at: null });
      expect(entry).toMatchObject({
        units: 1,
        bender: true,
        needs_check: false,
      });
    });

    it("changes a variant, minutes and day", async () => {
      expect(await patch("gym", { variant: "legs" })).toMatchObject({
        variant: "legs",
      });
      expect(
        await patch("wh", { variant: "meditation", minutes: 20 }),
      ).toMatchObject({ variant: "meditation", minutes: 20 });
      expect(await patch("gym", { day: "2026-10-12" })).toMatchObject({
        day: "2026-10-12",
      });
    });

    it("rejects what does not fit the kind", async () => {
      await expect(patch("gym", { variant: "wim_hof" })).rejects.toThrow(
        ValidationError,
      );
      await expect(patch("night", { variant: "gym" })).rejects.toThrow(
        ValidationError,
      );
      await expect(patch("gym", { home_at: "03:00" })).rejects.toThrow(
        ValidationError,
      );
      await expect(patch("night", { minutes: 10 })).rejects.toThrow(
        ValidationError,
      );
    });

    it("finds only the owner's live rows", async () => {
      await seed(
        { id: "theirs", kind: "training", day: "2026-10-13", userId: "x" },
        {
          id: "gone",
          kind: "training",
          day: "2026-10-13",
          deletedAt: "2026-10-13T09:00:00.000Z",
        },
      );
      await expect(patch("theirs", { variant: "push" })).rejects.toThrow(
        NotFoundError,
      );
      await expect(patch("gone", { variant: "push" })).rejects.toThrow(
        NotFoundError,
      );
      await expect(patch("nope", { variant: "push" })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("writes an update event with before and after in the same batch", async () => {
      await patch("night", { home_at: "04:30" });
      const [event] = await events();
      expect(event?.action).toBe("update");
      expect(JSON.parse(event?.before_json ?? "{}")).toMatchObject({
        homeAt: null,
        needsCheck: true,
      });
      expect(JSON.parse(event?.after_json ?? "{}")).toMatchObject({
        homeAt: "04:30",
        units: 1,
        edited: true,
      });
    });
  });

  describe("dismissing a label", () => {
    it("hides the row, writes one event, and is idempotent", async () => {
      await seed({ id: "g", kind: "training", day: "2026-10-13" });
      const first = await healthDismissEntry(rt.db, {
        userId: rt.user.id,
        entryId: "g",
      });
      await healthDismissEntry(rt.db, { userId: rt.user.id, entryId: "g" });
      expect(first.id).toBe("g");
      expect((await events()).map((event) => event.action)).toEqual([
        "dismiss",
      ]);
      const week = await healthReadWeek(rt.db, {
        userId: rt.user.id,
        now: NOW,
      });
      expect(week.entries).toEqual([]);
      const [row] = await plannerTestRows<{ deleted_at: string | null }>(
        rt.database,
        "SELECT deleted_at FROM health_entry WHERE id = 'g'",
      );
      expect(row?.deleted_at).toBeNull();
    });
  });
});
