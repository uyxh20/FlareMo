import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemo } from "../memos-write";
import {
  type PlannerTestRuntime,
  plannerTestRows,
  plannerTestRuntime,
} from "../planner/test-support";
import { forkRenameTag } from "./tag-rename";

// The careful tag rename (fork-owned, used for #gym -> #fitness) against a real
// D1: what a dry run reports, what a run writes, what it never touches, and
// that a run limited to its own memos undoes it.

type MemoRowLite = {
  id: string;
  content: string;
  payload: string;
  updated_at: string;
};

describe("fork tag rename", () => {
  let rt: PlannerTestRuntime;
  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-fork-tag-rename");
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
        "health_sync_state",
        "memo_revisions",
        "memo_tags",
        "memos",
      ].map((table) => rt.database.prepare(`DELETE FROM ${table}`)),
    );
  });

  const write = (content: string) =>
    createMemo(rt.db, rt.user, {
      content,
      visibility: "private",
      source: "web",
    });
  const memo = async (id: string) =>
    (
      await plannerTestRows<MemoRowLite>(
        rt.database,
        `SELECT id, content, payload, updated_at FROM memos WHERE id = '${id}'`,
      )
    )[0] as MemoRowLite;
  const tagRows = (tag: string) =>
    plannerTestRows<{ memo_id: string }>(
      rt.database,
      `SELECT memo_id FROM memo_tags WHERE tag = '${tag}' ORDER BY memo_id`,
    );
  const healthRows = () =>
    plannerTestRows<{ memo_id: string; kind: string; variant: string }>(
      rt.database,
      "SELECT memo_id, kind, variant FROM health_entry ORDER BY memo_id, kind",
    );

  it("a dry run reports and changes nothing", async () => {
    const a = await write("#gym back day done");
    const before = await memo(a.id);
    const result = await forkRenameTag(rt.db, rt.user, {
      from: "gym",
      to: "fitness",
      dryRun: true,
    });
    expect(result.written).toBe(false);
    expect(result.totals).toMatchObject({
      memos: 1,
      replacements: 1,
      tag_rows: 1,
      payload_tags: 1,
      health_changes: 0,
      text_check_failures: 0,
    });
    expect(result.memos[0]).toMatchObject({
      id: a.id,
      before_length: 18,
      after_length: 22,
    });
    expect(await memo(a.id)).toEqual(before);
    expect(await tagRows("fitness")).toEqual([]);
  });

  it("renames text, payload and tag rows, keeps updated_at and health rows", async () => {
    const a = await write("#gym back day done");
    const b = await write("#Gym then #crossfit, also #gymnastics and gym.com");
    const c = await write("`#gym` in code and https://x.test/#gym stays");
    const d = await write("#gymnastics only");
    const before = {
      a: await memo(a.id),
      b: await memo(b.id),
      c: await memo(c.id),
      d: await memo(d.id),
    };
    const healthBefore = await healthRows();

    const result = await forkRenameTag(rt.db, rt.user, {
      from: "gym",
      to: "fitness",
      dryRun: false,
    });
    expect(result.written).toBe(true);
    expect(result.memos.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());

    const after = { a: await memo(a.id), b: await memo(b.id) };
    expect(after.a.content).toBe("#fitness back day done");
    expect(after.b.content).toBe(
      "#fitness then #crossfit, also #gymnastics and gym.com",
    );
    expect(JSON.parse(after.a.payload).tags).toEqual(["fitness"]);
    expect(JSON.parse(after.b.payload).tags).toEqual([
      "crossfit",
      "fitness",
      "gymnastics",
    ]);
    expect(after.a.updated_at).toBe(before.a.updated_at);
    expect(after.b.updated_at).toBe(before.b.updated_at);
    expect(await memo(c.id)).toEqual(before.c);
    expect(await memo(d.id)).toEqual(before.d);
    expect(await tagRows("gym")).toEqual([]);
    expect((await tagRows("fitness")).map((r) => r.memo_id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(await tagRows("gymnastics")).toHaveLength(2);
    expect(await healthRows()).toEqual(healthBefore);

    // The undo record: one revision per changed memo with the old text.
    const revisions = await plannerTestRows<{
      memo_id: string;
      content: string;
    }>(rt.database, "SELECT memo_id, content FROM memo_revisions");
    expect(
      revisions.filter((r) => r.memo_id === a.id).map((r) => r.content),
    ).toContain(before.a.content);

    // Undo: rename back on exactly the memos the run changed.
    const later = await write("#fitness sauna 20 min");
    await forkRenameTag(rt.db, rt.user, {
      from: "fitness",
      to: "gym",
      dryRun: false,
      memoIds: result.memos.map((m) => m.id),
    });
    expect((await memo(a.id)).content).toBe(before.a.content);
    expect((await memo(b.id)).content).toBe(
      before.b.content.replace("#Gym", "#gym"),
    );
    expect((await memo(later.id)).content).toBe("#fitness sauna 20 min");
    expect((await healthRows()).filter((r) => r.memo_id !== later.id)).toEqual(
      healthBefore,
    );
  });

  it("stops before writing when the health reader would change", async () => {
    const a = await write("#gym sauna 20 min");
    const before = await memo(a.id);
    const dry = await forkRenameTag(rt.db, rt.user, {
      from: "gym",
      to: "fitness",
      dryRun: true,
    });
    expect(dry.totals.health_changes).toBe(1);
    await expect(
      forkRenameTag(rt.db, rt.user, {
        from: "gym",
        to: "fitness",
        dryRun: false,
      }),
    ).rejects.toThrow(/health tracker would read 1 memo/);
    expect(await memo(a.id)).toEqual(before);
  });

  it("refuses nested or identical tags", async () => {
    await expect(
      forkRenameTag(rt.db, rt.user, { from: "gym", to: "gym", dryRun: true }),
    ).rejects.toThrow();
    await expect(
      forkRenameTag(rt.db, rt.user, {
        from: "gym/a",
        to: "fitness",
        dryRun: true,
      }),
    ).rejects.toThrow();
  });
});
