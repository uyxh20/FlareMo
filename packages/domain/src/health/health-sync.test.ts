import { applyFlaremoMigrations, createDb } from "@flaremo/db";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hardDeleteMemo } from "../memos-lifecycle";
import { createMemo, updateMemo } from "../memos-write";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "../planner/test-support";
import type { HealthParsedEntry } from "./parse";
import { healthToday } from "./read";
import type { HealthEntryRow } from "./rows";
import {
  healthEnsureScanned,
  healthNightlySweep,
  healthPlanMemoSync,
  healthRescan,
  healthSyncMemo,
} from "./sync";
import { healthDismissEntry, healthPatchEntry } from "./write";

// The health tracker's sync against a real D1 (fork-owned add-on,
// docs/fork-health-tracker.md): what a memo save writes, what a re-read keeps,
// and the guarantees around the owner's edits, dismissals and the history.

type Row = {
  id: string;
  kind: string;
  day: string;
  variant: string | null;
  minutes: number | null;
  home_at: string | null;
  units: number | null;
  bender: number;
  needs_check: number;
  dismissed: number;
  edited: number;
  memo_id: string | null;
  deleted_at: string | null;
};

describe("health sync", () => {
  let rt: PlannerTestRuntime;
  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-health-sync");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      [
        "health_entry_event",
        "health_entry",
        "health_target",
        "health_sync_state",
        "memos",
      ].map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows = () =>
    plannerTestRows<Row>(
      rt.database,
      "SELECT * FROM health_entry ORDER BY kind, created_at",
    );
  const events = () =>
    plannerTestRows<{
      action: string;
      entry_id: string;
      before_json: string | null;
      after_json: string | null;
    }>(rt.database, "SELECT * FROM health_entry_event ORDER BY at, rowid");

  async function write(content: string, tags?: string[]) {
    return createMemo(rt.db, rt.user, {
      content,
      visibility: "private",
      source: "web",
      payload: tags ? { tags } : undefined,
    });
  }

  it("reads a saved memo into rows, one event each", async () => {
    const memo = await write("crossfit done, wim hof 10");
    const found = await rows();
    expect(found.map((row) => [row.kind, row.variant, row.minutes])).toEqual([
      ["breath", "wim_hof", 10],
      ["training", "crossfit", null],
    ]);
    expect(found.every((row) => row.memo_id === memo.id)).toBe(true);
    expect(found.every((row) => row.day === healthToday())).toBe(true);
    expect((await events()).map((event) => event.action)).toEqual([
      "create",
      "create",
    ]);
  });

  it("moves a row to the new day when the memo is backdated", async () => {
    const memo = await write("crossfit done");
    await updateMemo(rt.db, rt.user, memo.id, {
      created_at: "2026-03-02T12:00:00.000Z",
    });
    const live = (await rows()).filter((row) => row.deleted_at === null);
    expect(live.map((row) => [row.kind, row.day])).toEqual([
      ["training", "2026-03-02"],
    ]);
  });

  it("reads nothing from a plan, and writes no event", async () => {
    await write("gym tomorrow");
    expect(await rows()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("skips a summary memo by its tag", async () => {
    await write("crossfit done", ["vault-summary"]);
    expect(await rows()).toEqual([]);
  });

  it("changes a row when the memo changes", async () => {
    const memo = await write("#gym back day done");
    await updateMemo(rt.db, rt.user, memo.id, {
      content: "#gym chest day done",
    });
    const [row] = await rows();
    expect(row?.variant).toBe("chest");
    const log = await events();
    expect(log.map((event) => event.action)).toEqual(["create", "update"]);
    expect(JSON.parse(log[1]?.before_json ?? "{}").variant).toBe("back");
    expect(JSON.parse(log[1]?.after_json ?? "{}").variant).toBe("chest");
  });

  it("soft-deletes a row when the signal goes, and restores it when it returns", async () => {
    const memo = await write("wim hof 10");
    await updateMemo(rt.db, rt.user, memo.id, { content: "just a note" });
    expect((await rows())[0]?.deleted_at).not.toBeNull();
    await updateMemo(rt.db, rt.user, memo.id, { content: "wim hof 15" });
    const [row] = await rows();
    expect(row?.deleted_at).toBeNull();
    expect(row?.minutes).toBe(15);
    expect((await events()).map((event) => event.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
  });

  it("soft-deletes the rows of a trashed memo and brings them back", async () => {
    const memo = await write("crossfit done");
    await updateMemo(rt.db, rt.user, memo.id, { status: "trashed" });
    expect((await rows())[0]?.deleted_at).not.toBeNull();
    await updateMemo(rt.db, rt.user, memo.id, { status: "normal" });
    expect((await rows())[0]?.deleted_at).toBeNull();
  });

  it("leaves a dismissed row dismissed through edits and a rescan", async () => {
    const memo = await write("crossfit done");
    const [row] = await rows();
    await healthDismissEntry(rt.db, {
      userId: rt.user.id,
      entryId: row?.id ?? "",
    });
    await updateMemo(rt.db, rt.user, memo.id, {
      content: "crossfit done again",
    });
    await healthRescan(rt.db, rt.user.id);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.dismissed).toBe(1);
    expect(after[0]?.deleted_at).toBeNull();
    expect((await events()).map((event) => event.action)).toEqual([
      "create",
      "dismiss",
    ]);
  });

  it("keeps the owner's answer when the memo is edited", async () => {
    const memo = await write("went out Saturday");
    const [asked] = await rows();
    expect(asked).toMatchObject({ needs_check: 1, units: null });
    await healthPatchEntry(rt.db, {
      userId: rt.user.id,
      entryId: asked?.id ?? "",
      patch: { home_at: "01:30" },
    });
    await updateMemo(rt.db, rt.user, memo.id, {
      content: "went out Saturday til 5am",
    });
    await healthRescan(rt.db, rt.user.id);
    const [kept] = await rows();
    expect(kept).toMatchObject({
      home_at: "01:30",
      units: 0.5,
      needs_check: 0,
      edited: 1,
    });
  });

  it("removes an edited row when its signal disappears", async () => {
    const memo = await write("went out Saturday");
    const [asked] = await rows();
    await healthPatchEntry(rt.db, {
      userId: rt.user.id,
      entryId: asked?.id ?? "",
      patch: { home_at: "04:30" },
    });
    await updateMemo(rt.db, rt.user, memo.id, { content: "stayed in" });
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it("never doubles a row when two syncs race", async () => {
    const memo = await write("wim hof 10");
    await rt.database.batch([
      rt.database.prepare("DELETE FROM health_entry_event"),
      rt.database.prepare("DELETE FROM health_entry"),
    ]);
    const input = {
      id: memo.id,
      userId: rt.user.id,
      content: memo.content,
      createdAt: memo.createdAt,
      status: "normal",
      deletedAt: null,
      payload: { tags: [] },
    };
    await Promise.all([
      healthSyncMemo(rt.db, input),
      healthSyncMemo(rt.db, input),
      healthSyncMemo(rt.db, input),
    ]);
    expect(await rows()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("does nothing for a memo that is already in line", async () => {
    const memo = await write("wim hof 10");
    const counts = await healthSyncMemo(rt.db, {
      ...memo,
      payload: { tags: [] },
    });
    expect(counts).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(await events()).toHaveLength(1);
  });

  it("never fails a memo save when the health tables do not exist", async () => {
    const mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-health-no-tables" },
    });
    try {
      const database = await mf.getD1Database("DB");
      const db = createDb(database);
      await applyFlaremoMigrations(database);
      const { ensureSingleUser } = await import("../users");
      const owner = await ensureSingleUser(db, {
        email: "owner@example.com",
        name: "Owner",
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const created = await createMemo(db, owner, {
        content: "crossfit done",
        visibility: "private",
        source: "web",
      });
      expect(created.content).toBe("crossfit done");
      expect(warn).toHaveBeenCalled();
    } finally {
      await mf.dispose();
    }
  });

  describe("rescan", () => {
    async function backdate(id: string, createdAt: string) {
      await plannerTestRun(
        rt.database,
        "UPDATE memos SET created_at = ?, updated_at = ? WHERE id = ?",
        createdAt,
        createdAt,
        id,
      );
    }

    it("reads the whole diary, then changes nothing the second time", async () => {
      const gym = await write("#gym push day done");
      const out = await write("went out Friday til 0330");
      await write("a plain note");
      await backdate(gym.id, "2026-10-12T16:00:00.000Z");
      await backdate(out.id, "2026-10-12T08:00:00.000Z");
      await rt.database.batch([
        rt.database.prepare("DELETE FROM health_entry_event"),
        rt.database.prepare("DELETE FROM health_entry"),
      ]);
      const first = await healthRescan(rt.db, rt.user.id);
      expect(first).toEqual({ memos: 3, created: 2, updated: 0, removed: 0 });
      const found = await rows();
      expect(
        found.map((row) => [row.kind, row.day, row.variant, row.units]),
      ).toEqual([
        ["night_out", "2026-10-09", null, 1],
        ["training", "2026-10-12", "push", null],
      ]);
      const second = await healthRescan(rt.db, rt.user.id);
      expect(second).toEqual({ memos: 3, created: 0, updated: 0, removed: 0 });
      expect(await events()).toHaveLength(2);
    });

    it("handles a diary bigger than one batch", async () => {
      const count = 130;
      const statements = Array.from({ length: count }, (_, index) =>
        rt.database
          .prepare(
            "INSERT INTO memos (id, user_id, content, visibility, status, pinned, source, payload, created_at, updated_at) VALUES (?, ?, ?, 'private', 'normal', 0, 'web', '{}', ?, ?)",
          )
          .bind(
            `memos/bulk-${index}`,
            rt.user.id,
            index % 2 === 0 ? "wim hof 10" : "just a note",
            `2026-09-${String((index % 28) + 1).padStart(2, "0")}T0${index % 9}:00:00.000Z`,
            `2026-09-${String((index % 28) + 1).padStart(2, "0")}T0${index % 9}:00:00.000Z`,
          ),
      );
      await rt.database.batch(statements);
      const result = await healthRescan(rt.db, rt.user.id);
      expect(result).toMatchObject({ memos: count, created: 65 });
      expect(await rows()).toHaveLength(65);
    });

    it("removes rows whose memo is gone", async () => {
      const memo = await write("crossfit done");
      await hardDeleteMemo(rt.db, rt.user, memo.id);
      expect((await rows())[0]?.deleted_at).toBeNull();
      const result = await healthRescan(rt.db, rt.user.id);
      expect(result.removed).toBe(1);
      expect((await rows())[0]?.deleted_at).not.toBeNull();
    });

    it("reads the diary once, on the first call, and not again", async () => {
      await write("wim hof 10");
      await rt.database.batch([
        rt.database.prepare("DELETE FROM health_entry_event"),
        rt.database.prepare("DELETE FROM health_entry"),
      ]);
      expect(await healthEnsureScanned(rt.db, rt.user.id)).toBe(true);
      expect(await rows()).toHaveLength(1);
      expect(await healthEnsureScanned(rt.db, rt.user.id)).toBe(false);
      const [marker] = await plannerTestRows<{ memo_count: number }>(
        rt.database,
        "SELECT memo_count FROM health_sync_state",
      );
      expect(marker?.memo_count).toBe(1);
    });
  });

  describe("bookmark", () => {
    /** Memos straight into the table, the hook never seeing them. */
    async function insertMemos(
      list: Array<{
        id: string;
        content: string;
        at: string;
        updated?: string;
      }>,
    ) {
      for (let start = 0; start < list.length; start += 100) {
        await rt.database.batch(
          list
            .slice(start, start + 100)
            .map((memo) =>
              rt.database
                .prepare(
                  "INSERT INTO memos (id, user_id, content, visibility, status, pinned, source, payload, created_at, updated_at) VALUES (?, ?, ?, 'private', 'normal', 0, 'web', '{}', ?, ?)",
                )
                .bind(
                  memo.id,
                  rt.user.id,
                  memo.content,
                  memo.at,
                  memo.updated ?? memo.at,
                ),
            ),
        );
      }
    }
    const state = async () =>
      (
        await plannerTestRows<{
          memo_count: number;
          scan_cursor: string | null;
          scan_claimed_at: string | null;
          sweep_cursor: string | null;
        }>(rt.database, "SELECT * FROM health_sync_state")
      )[0];

    it("never skips memos that share a time across a page break", async () => {
      // 450 memos written in the same second: the second page starts inside
      // that second, and every memo is still read.
      await insertMemos(
        Array.from({ length: 450 }, (_, index) => ({
          id: `memos/same-${String(index).padStart(3, "0")}`,
          content: "wim hof 10",
          at: "2026-09-01T08:00:00.000Z",
        })),
      );
      const result = await healthRescan(rt.db, rt.user.id);
      expect(result).toMatchObject({ memos: 450, created: 450 });
      expect(await rows()).toHaveLength(450);
      expect(await state()).toMatchObject({
        memo_count: 450,
        scan_cursor: null,
        scan_claimed_at: null,
      });
    });

    it("carries on after a first read that was cut off", async () => {
      await insertMemos(
        Array.from({ length: 450 }, (_, index) => ({
          id: `memos/cut-${String(index).padStart(3, "0")}`,
          content:
            index === 5 || index === 420 ? "crossfit done" : "a plain note",
          at: new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString(),
        })),
      );
      // The second page's write fails, as if the run were stopped there.
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const batch = rt.db.batch.bind(rt.db);
      let calls = 0;
      const spy = vi.spyOn(rt.db, "batch").mockImplementation(((
        statements: Parameters<typeof batch>[0],
      ) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("cut off"));
        return batch(statements);
      }) as unknown as typeof rt.db.batch);
      expect(await healthEnsureScanned(rt.db, rt.user.id)).toBe(false);
      expect(error).toHaveBeenCalled();
      spy.mockRestore();
      const halfway = await state();
      expect(halfway?.memo_count).toBe(400);
      expect(halfway?.scan_cursor).toMatch(/^\[/);
      expect(halfway?.scan_claimed_at).toBeNull();
      expect(await rows()).toHaveLength(1);

      // The next health request reads only the rest, and finishes.
      expect(await healthEnsureScanned(rt.db, rt.user.id)).toBe(true);
      expect(await rows()).toHaveLength(2);
      expect(await events()).toHaveLength(2);
      expect(await state()).toMatchObject({
        memo_count: 450,
        scan_cursor: null,
      });
      expect(await healthEnsureScanned(rt.db, rt.user.id)).toBe(false);
    });

    it("lets a run that died be taken over, but not a live one", async () => {
      await insertMemos([
        {
          id: "memos/a",
          content: "crossfit done",
          at: "2026-08-01T08:00:00.000Z",
        },
      ]);
      const now = new Date("2026-10-15T09:00:00.000Z");
      await plannerTestRun(
        rt.database,
        "INSERT INTO health_sync_state (user_id, scanned_at, memo_count, scan_cursor, scan_claimed_at) VALUES (?, ?, 0, '', ?)",
        rt.user.id,
        now.toISOString(),
        "2026-10-15T08:58:00.000Z",
      );
      // Claimed two minutes ago: someone is reading.
      expect(await healthEnsureScanned(rt.db, rt.user.id, now)).toBe(false);
      expect(await rows()).toHaveLength(0);
      // Ten minutes later the claim is stale and this call finishes the read.
      const later = new Date(now.getTime() + 10 * 60_000);
      expect(await healthEnsureScanned(rt.db, rt.user.id, later)).toBe(true);
      expect(await rows()).toHaveLength(1);
    });

    it("the nightly sweep finishes a cut-off read and carries on its own walk", async () => {
      const now = new Date("2026-10-15T03:00:00.000Z");
      await insertMemos([
        // Changed a week ago, before the three days: only the bookmark finds it.
        {
          id: "memos/old",
          content: "wim hof 10",
          at: "2026-10-01T08:00:00.000Z",
          updated: "2026-10-08T08:00:00.000Z",
        },
        {
          id: "memos/new",
          content: "crossfit done",
          at: "2026-10-14T08:00:00.000Z",
        },
      ]);
      await plannerTestRun(
        rt.database,
        "INSERT INTO health_sync_state (user_id, scanned_at, memo_count, scan_cursor, sweep_cursor) VALUES (?, ?, 0, NULL, ?)",
        rt.user.id,
        now.toISOString(),
        JSON.stringify(["2026-10-07T00:00:00.000Z", "memos/z"]),
      );
      const result = await healthNightlySweep(rt.db, now);
      expect(result).toMatchObject({ users: 1, created: 2 });
      expect((await state())?.sweep_cursor).toBeNull();
    });
  });

  describe("nightly sweep", () => {
    it("re-reads memos changed in the last three days and drops rows of gone memos", async () => {
      const kept = await write("wim hof 10");
      const gone = await write("crossfit done");
      // The hook missed both: no rows, then a memo that vanished without one.
      await rt.database.batch([
        rt.database.prepare("DELETE FROM health_entry_event"),
        rt.database.prepare("DELETE FROM health_entry"),
      ]);
      await healthSyncMemo(rt.db, {
        ...gone,
        payload: { tags: [] },
      });
      await plannerTestRun(
        rt.database,
        "DELETE FROM memos WHERE id = ?",
        gone.id,
      );
      const result = await healthNightlySweep(rt.db, new Date());
      expect(result).toMatchObject({ users: 1, created: 1, removed: 1 });
      const found = await rows();
      expect(
        found.find((row) => row.memo_id === kept.id)?.deleted_at,
      ).toBeNull();
      expect(
        found.find((row) => row.memo_id === gone.id)?.deleted_at,
      ).not.toBeNull();
    });

    it("never throws", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = {
        all: () => Promise.reject(new Error("D1 is down")),
      } as unknown as Parameters<typeof healthNightlySweep>[0];
      await expect(healthNightlySweep(broken, new Date())).resolves.toEqual({
        users: 0,
        created: 0,
        updated: 0,
        removed: 0,
      });
      expect(error).toHaveBeenCalled();
    });
  });
});

describe("healthPlanMemoSync", () => {
  const base: HealthEntryRow = {
    id: "e1",
    userId: "u1",
    kind: "training",
    day: "2026-10-13",
    variant: "gym",
    minutes: null,
    homeAt: null,
    units: null,
    bender: false,
    needsCheck: false,
    feel: null,
    source: "memo",
    memoId: "memos/m1",
    dismissed: false,
    edited: false,
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    deletedAt: null,
  };
  const read: HealthParsedEntry = {
    kind: "training",
    day: "2026-10-13",
    variant: "gym",
    minutes: null,
    homeAt: null,
    units: null,
    bender: false,
    needsCheck: false,
    feel: null,
  };
  const now = "2026-10-14T10:00:00.000Z";
  const plan = (existing: HealthEntryRow[], parsed: HealthParsedEntry[]) =>
    healthPlanMemoSync({
      memoId: "memos/m1",
      userId: "u1",
      existing,
      parsed,
      now,
      newId: () => "new-id",
    });

  it("inserts, updates, deletes and restores", () => {
    expect(plan([], [read]).map((w) => w.action)).toEqual(["create"]);
    expect(
      plan([base], [{ ...read, variant: "back" }]).map((w) => w.action),
    ).toEqual(["update"]);
    expect(plan([base], []).map((w) => w.action)).toEqual(["delete"]);
    expect(
      plan([{ ...base, deletedAt: "2026-10-13T12:00:00.000Z" }], [read]).map(
        (w) => w.action,
      ),
    ).toEqual(["restore"]);
    expect(plan([base], [read])).toEqual([]);
  });

  it("leaves dismissed and edited rows alone", () => {
    expect(
      plan([{ ...base, dismissed: true }], [{ ...read, variant: "back" }]),
    ).toEqual([]);
    expect(plan([{ ...base, dismissed: true }], [])).toEqual([]);
    expect(
      plan([{ ...base, edited: true }], [{ ...read, variant: "back" }]),
    ).toEqual([]);
  });
});
