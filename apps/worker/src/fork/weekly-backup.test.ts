import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { FORK_EXPORT_TABLES } from "@flaremo/domain/src/fork/export";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlareMoEnv } from "../env";
import { createTestRuntime } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";
import { FORK_AGENT_SUNDAY_CRON, forkAgentScheduled } from "./agent-schedule";
import { forkWeeklyBackup } from "./weekly-backup";

// The weekly long-term backup (weekly-backup.ts): which Sunday firing takes it,
// that a second firing the same day is a no-op, and that the saved file holds
// every fork table with the database's row counts.

describe("weekly backup", () => {
  let runtime: Miniflare;
  let env: FlareMoEnv;
  let d1: D1Database;

  beforeAll(async () => {
    const created = await createTestRuntime({ name: "fork-weekly-backup" });
    runtime = created.runtime;
    d1 = created.db;
    env = { ...created.env, AI: undefined } as unknown as FlareMoEnv;
    await applyPlannerMigrations(d1);
    await bootstrapAndSignIn(env as unknown as Env);
    const user = await d1
      .prepare("SELECT id FROM users LIMIT 1")
      .first<{ id: string }>();
    const now = "2026-10-15T09:00:00.000Z";
    await d1
      .prepare(
        `INSERT INTO planner_goal (id, user_id, level, period_start, title, status, sort_order, created_at, updated_at)
         VALUES ('goal-1', ?, 'week', '2026-10-12', 'Backup goal', 'active', 0, ?, ?)`,
      )
      .bind(user?.id, now, now)
      .run();
  });

  afterAll(async () => {
    await runtime.dispose();
  });

  it("skips the firing that is noon in Copenhagen, where the agent's prep runs", async () => {
    // Sunday 18 October 2026, summer time: 10:00 UTC is noon in Copenhagen.
    expect(
      await forkWeeklyBackup(env, Date.parse("2026-10-18T10:00:00Z")),
    ).toBe("prep hour");
  });

  it("saves the export once per Sunday, under backups/weekly/<date>.json", async () => {
    const first = await forkWeeklyBackup(
      env,
      Date.parse("2026-10-18T11:00:00Z"),
    );
    expect(first).toMatchObject({ key: "backups/weekly/2026-10-18.json" });
    expect(
      await forkWeeklyBackup(env, Date.parse("2026-10-18T11:00:00Z")),
    ).toBe("exists already");

    const object = await env.ATTACHMENTS.get("backups/weekly/2026-10-18.json");
    const bundle = (await object?.json()) as {
      memos: unknown[];
      fork: {
        counts: Record<string, number>;
        tables: Record<string, unknown[]>;
      };
    };
    expect(Object.keys(bundle.fork.tables).sort()).toEqual(
      Object.keys(FORK_EXPORT_TABLES).sort(),
    );
    // A restore check: each table's count in the file matches the database.
    for (const table of Object.keys(FORK_EXPORT_TABLES)) {
      const row = await d1
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .first<{ n: number }>();
      expect(bundle.fork.tables[table], table).toHaveLength(row?.n ?? -1);
      expect(bundle.fork.counts[table], table).toBe(row?.n);
    }
    expect(JSON.stringify(bundle.fork.tables.planner_goal)).toContain(
      "Backup goal",
    );
  });

  it("runs from the Sunday cron, on the firing the prep does not take", async () => {
    // Sunday 25 October 2026, winter time from 03:00: 10:00 UTC is 11:00 in
    // Copenhagen, so the backup takes it; 11:00 UTC is the prep's noon.
    const cron = { cron: FORK_AGENT_SUNDAY_CRON };
    expect(
      await forkAgentScheduled(
        { ...cron, scheduledTime: Date.parse("2026-10-25T11:00:00Z") },
        env,
      ),
    ).toBe(true);
    expect(await env.ATTACHMENTS.head("backups/weekly/2026-10-25.json")).toBe(
      null,
    );
    await forkAgentScheduled(
      { ...cron, scheduledTime: Date.parse("2026-10-25T10:00:00Z") },
      env,
    );
    expect(
      await env.ATTACHMENTS.head("backups/weekly/2026-10-25.json"),
    ).not.toBe(null);
  });
});
