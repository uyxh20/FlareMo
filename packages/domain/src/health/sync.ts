import {
  type HealthEntryKind,
  type HealthRescanResponse,
  type HealthTrackerDraft,
  type HealthTrackerPreviewResponse,
  healthKinds,
  healthMaxMemoChars,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos } from "@flaremo/db";
import {
  healthEntry,
  healthSyncState,
} from "@flaremo/db/src/schema/fork-health";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { healthErrorText } from "./after-memo-write";
import {
  type HealthParseConfig,
  type HealthParsedEntry,
  healthParseMemo,
} from "./parse";
import {
  type HealthEntryRow,
  type HealthWrite,
  healthWriteStatements,
} from "./rows";
import {
  healthConfigWithDraft,
  healthEmptyPreview,
  healthReadParseConfig,
  healthReadTrackerRows,
} from "./trackers";

// The health projection (fork-owned add-on, docs/fork-health-tracker.md): the
// one module that turns what the parser reads in the diary into health_entry
// rows. Two ways in: one memo (`healthSyncMemoById`, after a save) and many
// (`projectPages`, behind the first read, Re-read, a tracker save and the nightly
// sweep), which walks the diary on a (time, id) key and keeps a bookmark.
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

export function healthParseLive(
  memo: HealthMemoInput,
  config: HealthParseConfig,
): HealthParsedEntry[] {
  if (!healthMemoIsLive(memo)) return [];
  return healthParseMemo(
    {
      content: memo.content,
      createdAt: memo.createdAt,
      tags: memo.payload?.tags,
      source: memo.source,
    },
    config,
  );
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
  // The built-in kinds, then every tracker kind the memo has a row of or now
  // reads as: a tracker that was archived or lost a word has its row removed.
  const kinds = new Set<HealthEntryKind>([
    ...healthKinds,
    ...existing.map((entry) => entry.kind),
    ...parsed.map((entry) => entry.kind),
  ]);
  for (const kind of kinds) {
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
  // Drizzle wraps D1's error: the reason is in `cause`, not the message.
  return /UNIQUE constraint failed/i.test(healthErrorText(error));
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
  const parsed = healthParseLive(
    memo,
    await healthReadParseConfig(db, memo.userId),
  );
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

// --- Many memos: the projection --------------------------------------------------
//
// Every read of more than one memo goes through `projectPages`: the first read of
// a diary, the Re-read button, a tracker save and the nightly read of changed
// memos. It walks the diary in pages on a (time, id) key, so memos that share a
// time are never skipped, and saves a bookmark in health_sync_state after every
// page, so a run that is cut off carries on where it stopped instead of being
// lost (migrations/9012_planner_health_bookmark.sql).

type ScannedMemo = HealthMemoInput & { updatedAt: string };

/** Where a walk of the diary has got: the last memo it finished. */
type Bookmark = { at: string; id: string };

type WalkOrder = "created" | "updated";

const MEMO_CHUNK = 40;
const ID_CHUNK = 50;
const PAGE = 400;
const GONE_PAGE = 500;
/** A claim on a full read older than this is a run that died. */
const CLAIM_STALE_MS = 5 * 60_000;
/** Pages one nightly run reads per user and per walk; the bookmark keeps the rest. */
const NIGHTLY_PAGES = 5;

function encodeBookmark(mark: Bookmark): string {
  return JSON.stringify([mark.at, mark.id]);
}

/** A saved bookmark, or null for '' (start from the beginning) and anything unreadable. */
function decodeBookmark(value: string | null): Bookmark | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // An unreadable bookmark starts the walk over, which is always safe.
  }
  return null;
}

/** A memo's columns for a scan; long memos come back empty (they are skipped). */
async function readScanMemos(
  db: FlareMoDb,
  where: ReturnType<typeof and>,
  limit: number,
  order: WalkOrder = "created",
): Promise<ScannedMemo[]> {
  const column = order === "created" ? memos.createdAt : memos.updatedAt;
  const rows = await db
    .select({
      id: memos.id,
      userId: memos.userId,
      createdAt: memos.createdAt,
      updatedAt: memos.updatedAt,
      status: memos.status,
      deletedAt: memos.deletedAt,
      source: memos.source,
      tags: sql<string | null>`json_extract(${memos.payload}, '$.tags')`,
      // A memo over the limit comes back blank, which reads as no entries.
      content: sql<string>`CASE WHEN length(${memos.content}) <= ${healthMaxMemoChars} THEN ${memos.content} ELSE '' END`,
    })
    .from(memos)
    .where(where)
    .orderBy(asc(column), asc(memos.id))
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
      updatedAt: row.updatedAt,
      status: row.status,
      deletedAt: row.deletedAt,
      source: row.source,
      payload: { tags },
      content: row.content,
    };
  });
}

/** One page of a user's memos after a bookmark, on a (time, id) key. */
function readPage(
  db: FlareMoDb,
  userId: string,
  order: WalkOrder,
  after: Bookmark | null,
): Promise<ScannedMemo[]> {
  const column = order === "created" ? memos.createdAt : memos.updatedAt;
  return readScanMemos(
    db,
    and(
      eq(memos.userId, userId),
      after
        ? sql`(${column} > ${after.at} OR (${column} = ${after.at} AND ${memos.id} > ${after.id}))`
        : undefined,
    ),
    PAGE,
    order,
  );
}

function bookmarkOf(memo: ScannedMemo, order: WalkOrder): Bookmark {
  return {
    at: order === "created" ? memo.createdAt : memo.updatedAt,
    id: memo.id,
  };
}

export async function healthReadRowsForMemos(
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
  config: HealthParseConfig,
): Promise<HealthSyncCounts> {
  let total: HealthSyncCounts = { created: 0, updated: 0, removed: 0 };
  for (let start = 0; start < list.length; start += MEMO_CHUNK) {
    const chunk = list.slice(start, start + MEMO_CHUNK);
    const existing = await healthReadRowsForMemos(
      db,
      userId,
      chunk.map((memo) => memo.id),
    );
    const writes = chunk.flatMap((memo) =>
      healthPlanMemoSync({
        memoId: memo.id,
        userId,
        existing: existing.get(memo.id) ?? [],
        parsed: healthParseLive(memo, config),
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
 * The one loop: reads a user's memos page by page after `from`, brings their
 * rows in line, and hands the bookmark of each finished page to `save`. Stops
 * at the end of the diary (`done`) or after `pages` pages.
 */
async function projectPages(
  db: FlareMoDb,
  input: {
    userId: string;
    order: WalkOrder;
    from: Bookmark | null;
    at: string;
    config: HealthParseConfig;
    pages?: number;
    save: (mark: Bookmark, read: number) => Promise<void>;
  },
): Promise<HealthSyncCounts & { memos: number; done: boolean }> {
  let counts: HealthSyncCounts = { created: 0, updated: 0, removed: 0 };
  let read = 0;
  let after = input.from;
  for (let page = 0; input.pages === undefined || page < input.pages; page++) {
    const list = await readPage(db, input.userId, input.order, after);
    const last = list[list.length - 1];
    if (!last) return { ...counts, memos: read, done: true };
    counts = addCounts(
      counts,
      await syncMemos(db, input.userId, list, input.at, input.config),
    );
    read += list.length;
    after = bookmarkOf(last, input.order);
    await input.save(after, list.length);
    if (list.length < PAGE) return { ...counts, memos: read, done: true };
  }
  return { ...counts, memos: read, done: false };
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
  let removed = 0;
  for (;;) {
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
      .limit(GONE_PAGE)
      .all();
    const writes: HealthWrite[] = orphans.map((row) => ({
      action: "delete" as const,
      before: row,
      after: { ...row, deletedAt: at, updatedAt: at },
    }));
    await applyWrites(db, writes, at);
    removed += writes.length;
    if (orphans.length < GONE_PAGE) return removed;
  }
}

/** Every memo of a user, oldest first, in pages so a big diary stays bounded. */
export async function* healthScanPages(
  db: FlareMoDb,
  userId: string,
): AsyncGenerator<ScannedMemo[]> {
  let after: Bookmark | null = null;
  for (;;) {
    const page = await readPage(db, userId, "created", after);
    const last = page[page.length - 1];
    if (!last) return;
    yield page;
    if (page.length < PAGE) return;
    after = bookmarkOf(last, "created");
  }
}

// --- The bookmark in health_sync_state -------------------------------------------

type SyncState = typeof healthSyncState.$inferSelect;

async function readState(
  db: FlareMoDb,
  userId: string,
): Promise<SyncState | undefined> {
  return db
    .select()
    .from(healthSyncState)
    .where(eq(healthSyncState.userId, userId))
    .get();
}

/**
 * Takes the full read of a user, unless a live run holds it. A user without a
 * state row gets one, with a full read waiting. Returns where the read starts,
 * or undefined when someone else has it or nothing is waiting.
 */
async function claimFullRead(
  db: FlareMoDb,
  userId: string,
  now: Date,
): Promise<{ from: Bookmark | null } | undefined> {
  const at = now.toISOString();
  const created = await db
    .insert(healthSyncState)
    .values({
      userId,
      scannedAt: at,
      memoCount: 0,
      scanCursor: "",
      scanClaimedAt: at,
    })
    .onConflictDoNothing()
    .returning({ userId: healthSyncState.userId });
  if (created.length > 0) return { from: null };
  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const claimed = await db
    .update(healthSyncState)
    .set({ scanClaimedAt: at })
    .where(
      and(
        eq(healthSyncState.userId, userId),
        sql`${healthSyncState.scanCursor} IS NOT NULL`,
        sql`(${healthSyncState.scanClaimedAt} IS NULL OR ${healthSyncState.scanClaimedAt} < ${stale})`,
      ),
    )
    .returning({ cursor: healthSyncState.scanCursor });
  const row = claimed[0];
  return row ? { from: decodeBookmark(row.cursor) } : undefined;
}

/** Runs a claimed full read from `from`, saving the bookmark after each page. */
async function runFullRead(
  db: FlareMoDb,
  userId: string,
  from: Bookmark | null,
  now: Date,
  pages?: number,
): Promise<HealthSyncCounts & { memos: number; done: boolean }> {
  const at = now.toISOString();
  try {
    const result = await projectPages(db, {
      userId,
      order: "created",
      from,
      at,
      config: await healthReadParseConfig(db, userId),
      pages,
      save: async (mark, read) => {
        await db
          .update(healthSyncState)
          .set({
            scanCursor: encodeBookmark(mark),
            memoCount: sql`${healthSyncState.memoCount} + ${read}`,
          })
          .where(eq(healthSyncState.userId, userId));
      },
    });
    if (!result.done) {
      // The rest waits for the next run; the claim is given back for it.
      await db
        .update(healthSyncState)
        .set({ scanClaimedAt: null })
        .where(eq(healthSyncState.userId, userId));
      return result;
    }
    const removed = await healthSweepGoneMemos(db, userId, now);
    await db
      .update(healthSyncState)
      .set({ scannedAt: at, scanCursor: null, scanClaimedAt: null })
      .where(eq(healthSyncState.userId, userId));
    return { ...result, removed: result.removed + removed };
  } catch (error) {
    // The bookmark keeps what was done; the next caller takes over at once.
    await db
      .update(healthSyncState)
      .set({ scanClaimedAt: null })
      .where(eq(healthSyncState.userId, userId))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Re-reads the user's whole diary from the start: the Re-read button and a
 * tracker save. Rows the owner dismissed or edited keep their state; rows of
 * memos that are gone are soft-deleted. If the run is cut off, the bookmark
 * lets the next health request finish it.
 */
export async function healthRescan(
  db: FlareMoDb,
  userId: string,
  now: Date = new Date(),
): Promise<HealthRescanResponse> {
  const at = now.toISOString();
  // Starts over whatever another run was doing; two runs at once are safe, they
  // only repeat work.
  await db
    .insert(healthSyncState)
    .values({
      userId,
      scannedAt: at,
      memoCount: 0,
      scanCursor: "",
      scanClaimedAt: at,
    })
    .onConflictDoUpdate({
      target: healthSyncState.userId,
      set: { memoCount: 0, scanCursor: "", scanClaimedAt: at },
    });
  const result = await runFullRead(db, userId, null, now);
  return {
    memos: result.memos,
    created: result.created,
    updated: result.updated,
    removed: result.removed,
  };
}

/**
 * Makes sure the diary has been read: on the first call to the health API, a
 * full read; after a read that was cut off, the rest of it. The claim keeps two
 * requests from reading at once; a run that died leaves a claim that goes stale
 * after a few minutes. Returns whether this call read anything. Never throws.
 */
export async function healthEnsureScanned(
  db: FlareMoDb,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const state = await readState(db, userId);
    if (state && state.scanCursor === null) return false;
    const claim = await claimFullRead(db, userId, now);
    if (!claim) return false;
    await runFullRead(db, userId, claim.from, now);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Health first scan failed",
        error: healthErrorText(error),
      }),
    );
    return false;
  }
}

/** Days of memos the nightly sweep re-reads. */
export const HEALTH_SWEEP_DAYS = 3;

/**
 * The nightly safety net, per user: finishes a full read that was cut off (or
 * starts one for a diary never read), re-reads every memo changed since the
 * last three days (an import, a failed hook, an edit that never reached the
 * hook), and soft-deletes rows whose memo is gone. Both walks are bounded per
 * night and keep a bookmark, so more than one night's worth carries on the next
 * night instead of being dropped. Never throws.
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
    const at = now.toISOString();
    const since = new Date(
      now.getTime() - HEALTH_SWEEP_DAYS * 86_400_000,
    ).toISOString();
    const users = await db.all<{ user_id: string }>(
      sql`SELECT user_id FROM health_sync_state UNION SELECT user_id FROM health_entry UNION SELECT user_id FROM memos WHERE updated_at >= ${since}`,
    );
    let total = { ...empty };
    for (const { user_id: userId } of users) {
      let counts: HealthSyncCounts = { created: 0, updated: 0, removed: 0 };
      const claim = await claimFullRead(db, userId, now);
      if (claim) {
        counts = addCounts(
          counts,
          await runFullRead(db, userId, claim.from, now, NIGHTLY_PAGES),
        );
      }
      // A bookmark is left only by a night that ran out of pages: carry on
      // from it. Otherwise read the last three days.
      const saved = decodeBookmark(
        (await readState(db, userId))?.sweepCursor ?? null,
      );
      const from: Bookmark = saved ?? { at: since, id: "" };
      const changed = await projectPages(db, {
        userId,
        order: "updated",
        from,
        at,
        config: await healthReadParseConfig(db, userId),
        pages: NIGHTLY_PAGES,
        save: async (mark) => {
          await db
            .update(healthSyncState)
            .set({ sweepCursor: encodeBookmark(mark) })
            .where(eq(healthSyncState.userId, userId));
        },
      });
      if (changed.done) {
        await db
          .update(healthSyncState)
          .set({ sweepCursor: null })
          .where(eq(healthSyncState.userId, userId));
      }
      counts = addCounts(counts, changed);
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
        error: healthErrorText(error),
      }),
    );
    return empty;
  }
}

// --- Preview ---------------------------------------------------------------------

const PREVIEW_DAYS = 30;

/**
 * What saving a draft tracker would change, without writing anything: the whole
 * diary is read with the draft and compared, for that one kind, to the rows
 * there now. A row the owner removed stays removed; one they fixed by hand
 * counts as kept.
 */
export async function healthPreviewTracker(
  db: FlareMoDb,
  input: { userId: string; draft: HealthTrackerDraft },
): Promise<HealthTrackerPreviewResponse> {
  const rows = await healthReadTrackerRows(db, input.userId);
  const { kind, config } = healthConfigWithDraft(rows, input.draft);
  const preview = healthEmptyPreview();
  const added = new Set<string>();
  const removed = new Set<string>();
  for await (const page of healthScanPages(db, input.userId)) {
    preview.memos += page.length;
    const existing = await healthReadRowsForMemos(
      db,
      input.userId,
      page.map((memo) => memo.id),
    );
    for (const memo of page) {
      const row = primaryRow(
        (existing.get(memo.id) ?? []).filter((entry) => entry.kind === kind),
      );
      const read = healthParseLive(memo, config).find(
        (entry) => entry.kind === kind,
      );
      const live = row && row.deletedAt === null;
      if (row?.dismissed) continue;
      if (read && !live) {
        preview.added += 1;
        added.add(read.day);
      } else if (read && row) {
        if (row.day === read.day || !row.edited) preview.unchanged += 1;
        else preview.kept += 1;
      } else if (!read && live) {
        // A gone signal removes even an edited row (see healthPlanMemoSync).
        preview.removed += 1;
        removed.add(row.day);
      }
    }
  }
  const newest = (days: Set<string>) =>
    [...days].sort((a, b) => (a < b ? 1 : -1)).slice(0, PREVIEW_DAYS);
  preview.added_days = newest(added);
  preview.removed_days = newest(removed);
  return preview;
}
