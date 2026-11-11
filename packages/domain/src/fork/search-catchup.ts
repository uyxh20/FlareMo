import type { EmbeddingTaskRow, FlareMoDb } from "@flaremo/db";
import { embeddingTasks, memos } from "@flaremo/db";
import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { EmbeddingProvider, VectorIndex } from "../embedding";
import { processEmbeddingTask } from "../embedding-processors";
import { markResourceEmbeddingError } from "../embedding-task-store";

// Search catch-up (fork-owned; docs/fork-customizations.md, "Search catch-up").
//
// Entries that reached D1 without an embedding task (bulk
// imports, mainly) sit at `not_indexed` forever: the outbox only works from its
// task rows and nothing sweeps the column. This job finds a few such rows per
// run and indexes them with the outbox's own per-resource processor, so the
// vectors and the D1 state come out exactly as a normal save leaves them.
//
// It never writes to the outbox, so a large backlog cannot crowd out new saves,
// and it needs no migration: the `not_indexed` mark is the to-do list, and a run
// with nothing left finds nothing. It is sized for the Workers Free plan, which
// allows 50 D1 queries per invocation: two candidate reads, then about four
// queries per resource (read, two usage counters, status update), plus one if
// it fails. CATCHUP_QUERY_BUDGET is what the tests hold it to.
//
// Upstream removed memories in v0.27, so this indexes entries only.

/** Entries indexed per run. */
export const SEARCH_CATCHUP_BATCH = 4;
/** Upper bound on D1 queries per run; the Free plan's cap is 50. */
export const CATCHUP_QUERY_BUDGET = 30;

export type SearchCatchupDeps = {
  provider: EmbeddingProvider | null;
  memosIndex: VectorIndex | null;
};

export type SearchCatchupResult = {
  indexed: number;
  failed: number;
  /** True when this run filled its batch, so more may be waiting. */
  more: boolean;
};

export async function runSearchCatchup(
  db: FlareMoDb,
  deps: SearchCatchupDeps,
  options: { batch?: number; now?: Date } = {},
): Promise<SearchCatchupResult> {
  const result: SearchCatchupResult = { indexed: 0, failed: 0, more: false };
  // Indexing off (dev's default): leave every row as it is.
  if (!deps.provider || !deps.memosIndex) return result;

  const batch = Math.max(1, options.batch ?? SEARCH_CATCHUP_BATCH);
  const nowIso = (options.now ?? new Date()).toISOString();

  // A resource with an open outbox task belongs to the outbox; skip it so the
  // two never index the same row at once.
  const openTask = (type: "memo", id: SQLiteColumn) =>
    db
      .select({ one: embeddingTasks.id })
      .from(embeddingTasks)
      .where(
        and(
          eq(embeddingTasks.resourceType, type),
          eq(embeddingTasks.resourceId, id),
          inArray(embeddingTasks.status, ["pending", "running"]),
        ),
      );

  const memoRows = await db
    .select({ id: memos.id, userId: memos.userId })
    .from(memos)
    .where(
      and(
        eq(memos.embeddingStatus, "not_indexed"),
        inArray(memos.status, ["normal", "archived"]),
        notExists(openTask("memo", memos.id)),
      ),
    )
    .orderBy(asc(memos.id))
    .limit(batch);

  const work = [...memoRows.map((row) => ({ ...row, type: "memo" as const }))];
  result.more = work.length >= batch;

  for (const item of work) {
    // The outbox processor reads only identity fields off the task; this row
    // is never written to the outbox.
    const task = {
      id: `catchup:${item.type}:${item.id}`,
      userId: item.userId,
      resourceType: item.type,
      resourceId: item.id,
      operation: "index",
      status: "running",
      attempts: 0,
      nextAttemptAt: nowIso,
      leaseUntil: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    } satisfies EmbeddingTaskRow;
    try {
      await processEmbeddingTask(db, deps, task, nowIso);
      result.indexed += 1;
    } catch (error) {
      // Mark it so the next run moves on; an edit or the admin rebuild
      // retries it. Keyword search is unaffected either way.
      const message =
        error instanceof Error && error.message
          ? error.message.slice(0, 500)
          : "Search catch-up failed.";
      await markResourceEmbeddingError(db, task, message).catch(
        () => undefined,
      );
      result.failed += 1;
    }
  }
  return result;
}
