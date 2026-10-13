import {
  type HealthKind,
  type HealthRescanResponse,
  healthKinds,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos } from "@flaremo/db";
import {
  healthEntry,
  healthSyncState,
} from "@flaremo/db/src/schema/fork-health";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { type HealthParsedEntry, healthParseMemo } from "./parse";
import {
  type HealthEntryRow,
  type HealthWrite,
  healthWriteStatements,
} from "./rows";

// The health tracker's sync (fork-owned add-on, docs/fork-health-tracker.md):
// turns what the parser reads in a memo into health_entry rows.
//
// The rules, per memo and kind (a memo yields at most one row per kind):
//   - new signal            -> insert
//   - signal changed        -> update, unless the owner edited the row
//   - signal gone           -> soft delete (deleted_at), never a hard delete
//   - signal back           -> restore, unless the owner dismissed the row
//   - dismissed row         -> left alone, whatever the memo says
//   - edited row            -> the owner's values stay; only deletion applies
//   - memo trashed/deleted  -> its rows are soft-deleted (restored if it returns)
// Every write comes with its event in the same D1 batch.

/** A memo as the sync reads it; MemoRow satisfies this. */
export type HealthMemoInput = {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
  status: string;
  deletedAt: string | null;
  source?: string | null;
  payload?: { tags?: string[] } | null;
};

export type HealthSyncCounts = {
  created: number;
  updated: number;
  removed: number;
};

const LIVE_STATUSES: readonly string[] = ["normal", "archived"];

/** Whether the owner's diary should be read for this memo. */
export function healthMemoIsLive(memo: {
  status: string;
  deletedAt: string | null;
}): boolean {
  return LIVE_STATUSES.includes(memo.status) && memo.deletedAt === null;
}

function parseLive(memo: HealthMemoInput): HealthParsedEntry[] {
  if (!healthMemoIsLive(memo)) return [];
  return healthParseMemo({
    content: memo.content,
    createdAt: memo.createdAt,
    tags: memo.payload?.tags,
    source: memo.source,
  });
}

function sameValues(row: HealthEntryRow, parsed: HealthParsedEntry): boolean {
  return (
    row.day === parsed.day &&
    row.variant === parsed.variant &&
    row.minutes === parsed.minutes &&
    row.homeAt === parsed.homeAt &&
    row.units === parsed.units &&
    row.bender === parsed.bender &&
    row.needsCheck === parsed.needsCheck &&
    row.feel === parsed.feel
  );
}

function withParsed(
  row: HealthEntryRow,
  parsed: HealthParsedEntry,
  now: string,
): HealthEntryRow {
  return {
    ...row,
    day: parsed.day,
    variant: parsed.variant,
    minutes: parsed.minutes,
    homeAt: parsed.homeAt,
    units: parsed.units,
    bender: parsed.bender,
    needsCheck: parsed.needsCheck,
    feel: parsed.feel,
    updatedAt: now,
  };
}

/** The row to compare against: a live one if any, else the latest. */
function primaryRow(rows: HealthEntryRow[]): HealthEntryRow | undefined {
  return [...rows].sort((a, b) => {
    if ((a.deletedAt === null) !== (b.deletedAt === null)) {
      return a.deletedAt === null ? -1 : 1;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  })[0];
}

/**
 * The writes that bring a memo's rows in line with what the parser read. Pure:
 * `existing` is every row of the memo with source `memo`, deleted ones too.
 */
export function healthPlanMemoSync(input: {
  memoId: string;
  userId: string;
  existing: HealthEntryRow[];
  parsed: HealthParsedEntry[];
  now: string;
  newId?: () => string;
}): HealthWrite[] {
  const { existing, parsed, now } = input;
  const newId = input.newId ?? (() => crypto.randomUUID());
  const writes: HealthWrite[] = [];
  for (const kind of healthKinds as readonly HealthKind[]) {
    const row = primaryRow(existing.filter((entry) => entry.kind === kind));
    const read = parsed.find((entry) => entry.kind === kind);
    if (read && !row) {
      writes.push({
        action: "create",
        after: {
          id: newId(),
          userId: input.userId,
          kind,
          day: read.day,
          variant: read.variant,
          minutes: read.minutes,
          homeAt: read.homeAt,
          units: read.units,
          bender: read.bender,
          needsCheck: read.needsCheck,
          feel: read.feel,
          source: "memo",
          memoId: input.memoId,
          dismissed: false,
          edited: false,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      });
    } else if (read && row) {
      if (row.dismissed) continue;
      if (row.deletedAt !== null) {
        // The signal is back. The owner's own edits survive the round trip.
        const restored = row.edited ? row : withParsed(row, read, now);
        writes.push({
          action: "restore",
          before: row,
          after: { ...restored, deletedAt: null, updatedAt: now },
        });
      } else if (!row.edited && !sameValues(row, read)) {
        writes.push({
          action: "update",
          before: row,
          after: withParsed(row, read, now),
        });
      }
    } else if (!read && row && row.deletedAt === null && !row.dismissed) {
      writes.push({
        action: "delete",
        before: row,
        after: { ...row, deletedAt: now, updatedAt: now },
      });
    }
  }
  return writes;
}

/** Writes per D1 batch: each write is two statements. */
const WRITES_PER_BATCH = 25;

function countOf(writes: HealthWrite[]): HealthSyncCounts {
  return {
    created: writes.filter((write) => write.action === "create").length,
    updated: writes.filter(
      (write) => write.action === "update" || write.action === "restore",
    ).length,
    removed: writes.filter((write) => write.action === "delete").length,
  };
}

function addCounts(a: HealthSyncCounts, b: HealthSyncCounts): HealthSyncCounts {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    removed: a.removed + b.removed,
  };
}

type BatchItems = Parameters<FlareMoDb["batch"]>[0];

async function applyWrites(
  db: FlareMoDb,
  writes: HealthWrite[],
  now: string,
): Promise<void> {
  for (let start = 0; start < writes.length; start += WRITES_PER_BATCH) {
    const statements = writes
      .slice(start, start + WRITES_PER_BATCH)
      .flatMap((write) => healthWriteStatements(db, write, now));
    await db.batch(statements as unknown as BatchItems);
  }
}

async function readMemoRows(
  db: FlareMoDb,
  userId: string,
  memoId: string,
): Promise<HealthEntryRow[]> {
  return db
    .select()
    .from(healthEntry)
    .where(
      and(
        eq(healthEntry.userId, userId),
        eq(healthEntry.memoId, memoId),
        eq(healthEntry.source, "memo"),
      ),
    )
    .all();
}

function isUniqueConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/**
 * Reads one memo and brings its rows in line. Safe to call twice and from two
 * places at once: a racing duplicate insert fails its whole batch (event
 * included) and is retried once against what the winner wrote.
 */
export async function healthSyncMemo(
  db: FlareMoDb,
  memo: HealthMemoInput,
  now: Date = new Date(),
): Promise<HealthSyncCounts> {
  const at = now.toISOString();
  const parsed = parseLive(memo);
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await readMemoRows(db, memo.userId, memo.id);
    const writes = healthPlanMemoSync({
      memoId: memo.id,
      userId: memo.userId,
      existing,
      parsed,
      now: at,
    });
    try {
      await applyWrites(db, writes, at);
      return countOf(writes);
    } catch (error) {
      if (attempt === 0 && isUniqueConflict(error)) continue;
      throw error;
    }
  }
  return { created: 0, updated: 0, removed: 0 };
}

/**
 * Reads a memo by id and brings its rows in line: what the memo write path
 * calls after a save. A memo that is gone has its rows removed.
 */
export async function healthSyncMemoById(
  db: FlareMoDb,
  memoId: string,
): Promise<HealthSyncCounts> {
  const [memo] = await readScanMemos(db, eq(memos.id, memoId), 1);
  if (!memo) {
    const rows = await db
      .select({ userId: healthEntry.userId })
      .from(healthEntry)
      .where(eq(healthEntry.memoId, memoId))
      .limit(1)
      .all();
    const userId = rows[0]?.userId;
    return userId
      ? healthSweepGoneMemos(db, userId).then((removed) => ({
          created: 0,
          updated: 0,
          removed,
        }))
      : { created: 0, updated: 0, removed: 0 };
  }
  return healthSyncMemo(db, memo);
}

// --- Many memos ----------------------------------------------------------------

type ScannedMemo = HealthMemoInput;

const MEMO_CHUNK = 40;
const ID_CHUNK = 50;

/** A memo's columns for a scan; long memos come back empty (they are skipped). */
async function readScanMemos(
  db: FlareMoDb,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<ScannedMemo[]> {
  const rows = await db
    .select({
      id: memos.id,
      userId: memos.userId,
      createdAt: memos.createdAt,
      status: memos.status,
      deletedAt: memos.deletedAt,
      source: memos.source,
      tags: sql<string | null>`json_extract(${memos.payload}, '$.tags')`,
      content: sql<string>`CASE WHEN length(${memos.content}) <= 1500 THEN ${memos.content} ELSE '' END`,
      length: sql<number>`length(${memos.content})`,
    })
    .from(memos)
    .where(where)
    .orderBy(asc(memos.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => {
    let tags: string[] = [];
    try {
      const parsed: unknown = row.tags ? JSON.parse(row.tags) : [];
      if (Array.isArray(parsed)) {
        tags = parsed.filter((tag): tag is string => typeof tag === "string");
      }
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      userId: row.userId,
      createdAt: row.createdAt,
      status: row.status,
      deletedAt: row.deletedAt,
      source: row.source,
      payload: { tags },
      // A memo over the limit is never read; keep it from being parsed.
      content: row.length > 1500 ? "x".repeat(1501) : row.content,
    };
  });
}

async function readRowsForMemos(
  db: FlareMoDb,
  userId: string,
  memoIds: string[],
): Promise<Map<string, HealthEntryRow[]>> {
  const byMemo = new Map<string, HealthEntryRow[]>();
  for (let start = 0; start < memoIds.length; start += ID_CHUNK) {
    const rows = await db
      .select()
      .from(healthEntry)
      .where(
        and(
          eq(healthEntry.userId, userId),
          eq(healthEntry.source, "memo"),
          inArray(healthEntry.memoId, memoIds.slice(start, start + ID_CHUNK)),
        ),
      )
      .all();
    for (const row of rows) {
      if (!row.memoId) continue;
      const list = byMemo.get(row.memoId) ?? [];
      list.push(row);
      byMemo.set(row.memoId, list);
    }
  }
  return byMemo;
}

/** Re-reads a list of memos, a chunk at a time. */
async function syncMemos(
  db: FlareMoDb,
  userId: string,
  list: ScannedMemo[],
  at: string,
): Promise<HealthSyncCounts> {
  let total: HealthSyncCounts = { created: 0, updated: 0, removed: 0 };
  for (let start = 0; start < list.length; start += MEMO_CHUNK) {
    const chunk = list.slice(start, start + MEMO_CHUNK);
    const existing = await readRowsForMemos(
      db,
      userId,
      chunk.map((memo) => memo.id),
    );
    const writes = chunk.flatMap((memo) =>
      healthPlanMemoSync({
        memoId: memo.id,
        userId,
        existing: existing.get(memo.id) ?? [],
        parsed: parseLive(memo),
        now: at,
      }),
    );
    try {
      await applyWrites(db, writes, at);
      total = addCounts(total, countOf(writes));
    } catch (error) {
      // A racing sync won some inserts: do the chunk one memo at a time, each
      // with its own retry.
      if (!isUniqueConflict(error)) throw error;
      for (const memo of chunk) {
        total = addCounts(total, await healthSyncMemo(db, memo, new Date(at)));
      }
    }
  }
  return total;
}

/**
 * Soft-deletes the live rows whose memo no longer exists (a hard delete or a
 * purge, which no hook sees). Returns how many rows it removed.
 */
export async function healthSweepGoneMemos(
  db: FlareMoDb,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const at = now.toISOString();
  const orphans = await db
    .select()
    .from(healthEntry)
    .where(
      and(
        eq(healthEntry.userId, userId),
        eq(healthEntry.source, "memo"),
        isNull(healthEntry.deletedAt),
        sql`${healthEntry.memoId} IS NOT NULL`,
        sql`NOT EXISTS (SELECT 1 FROM memos WHERE memos.id = ${healthEntry.memoId})`,
      ),
    )
    .limit(500)
    .all();
  const writes: HealthWrite[] = orphans.map((row) => ({
    action: "delete" as const,
    before: row,
    after: { ...row, deletedAt: at, updatedAt: at },
  }));
  await applyWrites(db, writes, at);
  return writes.length;
}

/** Every memo of a user, oldest first, in pages so a big diary stays bounded. */
async function* scanPages(
  db: FlareMoDb,
  userId: string,
): AsyncGenerator<ScannedMemo[]> {
  const PAGE = 400;
  let after = "";
  for (;;) {
    const page = await readScanMemos(
      db,
      and(eq(memos.userId, userId), sql`${memos.createdAt} > ${after}`),
      PAGE,
    );
    if (page.length === 0) return;
    yield page;
    const last = page[page.length - 1];
    if (page.length < PAGE || !last) return;
    after = last.createdAt;
  }
}

/**
 * Re-reads the user's whole diary. Rows the owner dismissed or edited keep
 * their state; rows of memos that are gone are soft-deleted. Marks the user as
 * scanned.
 */
export async function healthRescan(
  db: FlareMoDb,
  userId: string,
  now: Date = new Date(),
): Promise<HealthRescanResponse> {
  const at = now.toISOString();
  let counts: HealthSyncCounts = { created: 0, updated: 0, removed: 0 };
  let memoCount = 0;
  for await (const page of scanPages(db, userId)) {
    memoCount += page.length;
    counts = addCounts(counts, await syncMemos(db, userId, page, at));
  }
  counts.removed += await healthSweepGoneMemos(db, userId, now);
  await db
    .insert(healthSyncState)
    .values({ userId, scannedAt: at, memoCount })
    .onConflictDoUpdate({
      target: healthSyncState.userId,
      set: { scannedAt: at, memoCount },
    });
  return { memos: memoCount, ...counts };
}

/**
 * Reads the diary once for a user who has never been read: the first call to
 * the health API. Claims the marker first so two requests do not both scan; a
 * failed scan gives the claim back, so the next call tries again. Never throws.
 */
export async function healthEnsureScanned(
  db: FlareMoDb,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const marker = await db
      .select({ userId: healthSyncState.userId })
      .from(healthSyncState)
      .where(eq(healthSyncState.userId, userId))
      .get();
    if (marker) return false;
    const claimed = await db
      .insert(healthSyncState)
      .values({ userId, scannedAt: now.toISOString(), memoCount: 0 })
      .onConflictDoNothing()
      .returning({ userId: healthSyncState.userId });
    if (claimed.length === 0) return false;
    try {
      await healthRescan(db, userId, now);
      return true;
    } catch (error) {
      await db
        .delete(healthSyncState)
        .where(eq(healthSyncState.userId, userId))
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Health first scan failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/** Days of memos the nightly sweep re-reads. */
export const HEALTH_SWEEP_DAYS = 3;

/**
 * The nightly safety net: re-reads memos updated in the last three days (an
 * import, a failed hook, an edit that never reached the hook) and soft-deletes
 * rows whose memo is gone. Never throws and never blocks the caller's work.
 */
export async function healthNightlySweep(
  db: FlareMoDb,
  now: Date,
): Promise<{
  users: number;
  created: number;
  updated: number;
  removed: number;
}> {
  const empty = { users: 0, created: 0, updated: 0, removed: 0 };
  try {
    const since = new Date(
      now.getTime() - HEALTH_SWEEP_DAYS * 86_400_000,
    ).toISOString();
    const users = await db.all<{ user_id: string }>(
      sql`SELECT user_id FROM health_sync_state UNION SELECT user_id FROM health_entry UNION SELECT user_id FROM memos WHERE updated_at >= ${since}`,
    );
    let total = { ...empty };
    for (const { user_id: userId } of users) {
      const recent = await readScanMemos(
        db,
        and(eq(memos.userId, userId), gte(memos.updatedAt, since)),
        1000,
      );
      const counts = await syncMemos(db, userId, recent, now.toISOString());
      const removed = await healthSweepGoneMemos(db, userId, now);
      total = {
        users: total.users + 1,
        created: total.created + counts.created,
        updated: total.updated + counts.updated,
        removed: total.removed + counts.removed + removed,
      };
    }
    return total;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Health nightly sweep failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return empty;
  }
}
