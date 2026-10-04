import type { PatchMemoRelationsInput } from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { memoRelations, memos } from "@flaremo/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { NotFoundError, ValidationError } from "./errors";
import { parseResourceName } from "./ids";
import { getMemoById, getMemoByIdForViewer } from "./memos";
import { insertMemosSseEvent } from "./memos-sse";
import { assertCanEditMemo, memoReadScope } from "./team-permissions";

export async function listMemoRelations(
  db: FlareMoDb,
  user: UserRow | null,
  memoId: string,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  await getMemoByIdForViewer(db, user, normalizedMemoId);
  const rows = await db
    .select()
    .from(memoRelations)
    .where(eq(memoRelations.memoId, normalizedMemoId));
  return filterReadableRelations(db, user, normalizedMemoId, rows);
}

/**
 * List the complete relation set for a memo, including links where the memo
 * is the related target. Memos' ListMemoRelations RPC exposes both directions
 * while the legacy FlareMo relation helper historically returned only the
 * rows owned by `memoId`; keep the two contracts explicit.
 */
export async function listMemoRelationsForViewer(
  db: FlareMoDb,
  user: UserRow | null,
  memoId: string,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  await getMemoByIdForViewer(db, user, normalizedMemoId);
  const rows = await db
    .select()
    .from(memoRelations)
    .where(
      or(
        eq(memoRelations.memoId, normalizedMemoId),
        eq(memoRelations.relatedMemoId, normalizedMemoId),
      ),
    )
    .orderBy(asc(memoRelations.createdAt), asc(memoRelations.memoId));
  return filterReadableRelations(db, user, normalizedMemoId, rows);
}

/**
 * Batched sibling of {@link listMemoRelationsForViewer} for comment/list
 * hydration: one relation query and one readability probe for a whole page
 * instead of two round trips per memo. Each requested memo receives exactly
 * the rows the single-id helper would have returned for it — including rows
 * shared between two requested memos, which appear in both buckets.
 */
export async function listMemoRelationsForMemosForViewer(
  db: FlareMoDb,
  user: UserRow | null,
  memoIds: string[],
): Promise<Map<string, Array<typeof memoRelations.$inferSelect>>> {
  const requested = [
    ...new Set(memoIds.map((id) => parseResourceName(id, "memos"))),
  ];
  const grouped = new Map<string, Array<typeof memoRelations.$inferSelect>>(
    requested.map((id) => [id, []]),
  );
  if (requested.length === 0) return grouped;

  const requestedIds = new Set(requested);
  const rows = await db
    .select()
    .from(memoRelations)
    .where(
      or(
        inArray(memoRelations.memoId, requested),
        inArray(memoRelations.relatedMemoId, requested),
      ),
    )
    .orderBy(asc(memoRelations.createdAt), asc(memoRelations.memoId));
  if (rows.length === 0) return grouped;

  // Every id that can appear on the far side of a relation for a requested
  // memo; one probe answers readability for all of them.
  const farIds = new Set<string>();
  for (const row of rows) {
    if (requestedIds.has(row.memoId)) farIds.add(row.relatedMemoId);
    if (requestedIds.has(row.relatedMemoId)) farIds.add(row.memoId);
  }
  const readableIds = new Set<string>();
  if (farIds.size > 0) {
    const readable = await db
      .select({ id: memos.id })
      .from(memos)
      .where(and(memoReadScope(user), inArray(memos.id, [...farIds])));
    for (const row of readable) readableIds.add(row.id);
  }

  for (const row of rows) {
    if (requestedIds.has(row.memoId) && readableIds.has(row.relatedMemoId)) {
      grouped.get(row.memoId)?.push(row);
    }
    if (requestedIds.has(row.relatedMemoId) && readableIds.has(row.memoId)) {
      grouped.get(row.relatedMemoId)?.push(row);
    }
  }
  return grouped;
}

export async function replaceMemoRelations(
  db: FlareMoDb,
  user: UserRow,
  memoId: string,
  input: PatchMemoRelationsInput,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  const memo = await getMemoById(db, user, normalizedMemoId);
  assertCanEditMemo(user, memo);

  // A relation patch expresses the references the client wants; it never
  // touches comment relations, whose rows are keyed by the comment memo
  // itself and are managed by the comment lifecycle.
  const MAX_MEMO_RELATIONS = 200;
  const rows: Array<{
    memoId: string;
    relatedMemoId: string;
    type: "reference" | "comment";
    createdAt: string;
  }> = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const relation of input.relations) {
    if (relation.type !== "reference") continue;
    if (rows.length >= MAX_MEMO_RELATIONS) {
      throw new ValidationError(
        `A memo may carry at most ${MAX_MEMO_RELATIONS} relations`,
      );
    }
    const relatedMemoId = parseResourceName(relation.related_memo, "memos");
    const key = `${normalizedMemoId}:${relatedMemoId}:${relation.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      memoId: normalizedMemoId,
      relatedMemoId,
      type: relation.type,
      createdAt: now,
    });
  }

  if (rows.length > 0) {
    const relatedIds = [...new Set(rows.map((row) => row.relatedMemoId))];
    const relatedRows = await db
      .select({ id: memos.id })
      .from(memos)
      .where(and(memoReadScope(user), inArray(memos.id, relatedIds)));
    if (relatedRows.length !== relatedIds.length) {
      throw new NotFoundError("One or more related memos were not found");
    }
  }

  const deleteStatement = db
    .delete(memoRelations)
    .where(
      and(
        eq(memoRelations.memoId, normalizedMemoId),
        eq(memoRelations.type, "reference"),
      ),
    );
  const eventStatement = insertMemosSseEvent(db, {
    type: "memo.updated",
    name: memo.id,
    visibility: memo.visibility,
    teamId: memo.teamId,
    creatorId: memo.userId,
    createdAt: now,
  });
  if (rows.length > 0) {
    await db.batch([
      deleteStatement,
      db.insert(memoRelations).values(rows),
      eventStatement,
    ]);
  } else {
    await db.batch([deleteStatement, eventStatement]);
  }

  return listMemoRelations(db, user, normalizedMemoId);
}

export async function listMemoRelationContext(
  db: FlareMoDb,
  user: UserRow,
  memoId: string,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  await getMemoById(db, user, normalizedMemoId, { includeDeleted: true });
  const relations = await db
    .select()
    .from(memoRelations)
    .where(eq(memoRelations.memoId, normalizedMemoId));
  const related = await getRelatedMemos(
    db,
    user,
    relations.map((relation) => relation.relatedMemoId),
  );
  return relations.flatMap((relation) => {
    const memo = related.get(relation.relatedMemoId);
    return memo ? [{ relation, memo }] : [];
  });
}

export async function listMemoBacklinkContext(
  db: FlareMoDb,
  user: UserRow,
  memoId: string,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  await getMemoById(db, user, normalizedMemoId, { includeDeleted: true });
  const relations = await db
    .select()
    .from(memoRelations)
    .where(eq(memoRelations.relatedMemoId, normalizedMemoId));
  const related = await getRelatedMemos(
    db,
    user,
    relations.map((relation) => relation.memoId),
  );
  return relations.flatMap((relation) => {
    const memo = related.get(relation.memoId);
    return memo ? [{ relation, memo }] : [];
  });
}

export async function deleteMemoRelationsForMemo(
  db: FlareMoDb,
  memoId: string,
) {
  const normalizedMemoId = parseResourceName(memoId, "memos");
  await db
    .delete(memoRelations)
    .where(
      or(
        eq(memoRelations.memoId, normalizedMemoId),
        eq(memoRelations.relatedMemoId, normalizedMemoId),
      ),
    );
}

async function getRelatedMemos(db: FlareMoDb, user: UserRow, ids: string[]) {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(memos)
    .where(and(memoReadScope(user), inArray(memos.id, ids)));
  return new Map(rows.map((memo) => [memo.id, memo] as const));
}

async function filterReadableRelations(
  db: FlareMoDb,
  user: UserRow | null,
  memoId: string,
  rows: Array<typeof memoRelations.$inferSelect>,
) {
  const relatedIds = [
    ...new Set(
      rows.map((row) =>
        row.memoId === memoId ? row.relatedMemoId : row.memoId,
      ),
    ),
  ];
  if (relatedIds.length === 0) return [];
  const readable = await db
    .select({ id: memos.id })
    .from(memos)
    .where(and(memoReadScope(user), inArray(memos.id, relatedIds)));
  const readableIds = new Set(readable.map((row) => row.id));
  return rows.filter((row) =>
    readableIds.has(row.memoId === memoId ? row.relatedMemoId : row.memoId),
  );
}
