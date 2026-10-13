import { applyFlaremoMigrations, createDb } from "@flaremo/db";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import { readHourlyCountTotals } from "./memo-hourly-counts";
import { createMemo, updateMemo } from "./memos-write";
import type { TeamViewer } from "./team-permissions";
import { ensureTeamOwner } from "./test-support";

// Fork: editing a memo's created time (docs/fork-customizations.md).

let mf: Miniflare;
let db: ReturnType<typeof createDb>;
let owner: TeamViewer;

beforeEach(async () => {
  mf = new Miniflare({
    script: "export default { fetch() { return new Response('ok') } }",
    modules: true,
    compatibilityDate: "2026-07-10",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "flaremo-backdate-test" },
  });
  const database = await mf.getD1Database("DB");
  db = createDb(database);
  await applyFlaremoMigrations(database);
  owner = await ensureTeamOwner(db);
});

afterEach(async () => {
  await mf.dispose();
});

const make = (content: string) =>
  createMemo(db, owner, { content, visibility: "private", source: "web" });

describe("updateMemo created_at", () => {
  it("moves the memo and keeps the first time in the payload", async () => {
    const memo = await make("plain note");
    const first = await updateMemo(db, owner, memo.id, {
      created_at: "2026-03-02T09:30:00.000Z",
    });
    expect(first.createdAt).toBe("2026-03-02T09:30:00.000Z");
    expect(first.payload.original_created_at).toBe(memo.createdAt);
    // a second move keeps the very first time
    const second = await updateMemo(db, owner, memo.id, {
      created_at: "2026-03-05T10:00:00.000Z",
    });
    expect(second.createdAt).toBe("2026-03-05T10:00:00.000Z");
    expect(second.payload.original_created_at).toBe(memo.createdAt);
    expect(second.content).toBe("plain note");
  });

  it("moves the hourly count to the new hour", async () => {
    const memo = await make("counted");
    await updateMemo(db, owner, memo.id, {
      created_at: "2026-03-02T09:30:00.000Z",
    });
    const totals = await readHourlyCountTotals(db, owner.id);
    expect(totals.normal).toBe(1);
  });

  it("is a no-op for the same instant", async () => {
    const memo = await make("same");
    const again = await updateMemo(db, owner, memo.id, {
      created_at: memo.createdAt,
    });
    expect(again.createdAt).toBe(memo.createdAt);
    expect(again.payload.original_created_at).toBeUndefined();
  });

  it("rejects a future time", async () => {
    const memo = await make("future");
    await expect(
      updateMemo(db, owner, memo.id, {
        created_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
