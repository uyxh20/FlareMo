import type { MemoRow, UserRow } from "@flaremo/db";
import {
  getMemoById,
  getMemoParent,
  getMemoParentsForViewer,
  getMemosByIdsForViewer,
  listAttachmentsForMemosForViewer,
  listMemoAttachments,
  listMemoReactions,
  listMemoRelationsForMemosForViewer,
  listMemoRelationsForViewer,
  listReactionsForMemosForViewer,
  NotFoundError,
} from "@flaremo/domain";
import { currentMemoToDto } from "@flaremo/memos";
import type { getRequestContext } from "../../../context";
import { CompatValidationError } from "../../../memos-compat/errors";
import { resolveMemoCreator } from "../../../memos-compat/memo-creator";
import {
  memoRelationsToDtos,
  type RelationRow,
} from "../../../memos-compat/memo-relations";
import {
  parseMemosOrderBy,
  parseMemosState,
} from "../../../memos-compat/parsing";
import { normalizeMemoName } from "../../../memos-compat/resource-names";
import { type ConnectReadContext, optionalString, pageSize } from "../shared";

/**
 * Build a map-backed fetcher for {@link memoRelationsToDtos}: the endpoints of
 * every relation on the page are read in one query, and a missing id throws
 * the same NotFoundError the per-relation helper would have raised. Pass
 * `includeDeleted` where the single-id path did; the public read passes it
 * false, so trashed endpoints stay hidden there.
 */
async function relationMemoFetcher(
  context: Pick<ConnectReadContext, "db" | "user">,
  rows: readonly RelationRow[],
  options: { includeDeleted?: boolean } = {},
) {
  const memosById = await getMemosByIdsForViewer(
    context.db,
    context.user,
    [...new Set(rows.flatMap((row) => [row.memoId, row.relatedMemoId]))],
    options,
  );
  return async (id: string) => {
    const memo = memosById.get(id);
    if (!memo) throw new NotFoundError("Memo not found");
    return memo;
  };
}

/**
 * Shared body-to-legacy-list-query mapping for the authenticated
 * ListMemos and the anonymous public ListMemos read; both surfaces parsed
 * identical copies of this shape.
 */
export function connectMemoListQuery(body: Record<string, unknown>) {
  const orderBy = parseMemosOrderBy(
    optionalString(body.orderBy) ?? "create_time desc",
  );
  if (!orderBy) {
    throw new CompatValidationError(
      "orderBy must be one supported single-field order such as create_time desc",
    );
  }
  return {
    page_size: pageSize(body.pageSize),
    page_token: optionalString(body.pageToken),
    order_by: orderBy,
    state: stateToLegacy(optionalString(body.state)),
    filter: optionalString(body.filter),
    include_deleted: body.showDeleted === true,
  };
}

export async function connectMemoWithDetails(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  id: string,
) {
  const memo = await getMemoById(
    context.db,
    context.user,
    normalizeMemoName(id),
  );
  const [attachments, rows, reactionPage, parent] = await Promise.all([
    listMemoAttachments(context.db, context.user, memo.id),
    listMemoRelationsForViewer(context.db, context.user, memo.id),
    listMemoReactions(context.db, context.user, {
      memoName: memo.id,
      pageSize: 1_000,
    }),
    getMemoParent(context.db, context.user, memo.id),
  ]);
  const relations = await memoRelationsToDtos(
    rows,
    await relationMemoFetcher(context, rows, { includeDeleted: true }),
  );
  return currentMemoToDto(memo, context.user, {
    attachments,
    relations,
    reactions: reactionPage.reactions,
    parent,
  });
}

function groupByContentMemo<T>(
  rows: T[],
  memoKey: (row: T) => string | null | undefined,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const memoId = memoKey(row);
    if (!memoId) continue;
    const bucket = grouped.get(memoId) ?? [];
    bucket.push(row);
    grouped.set(memoId, bucket);
  }
  return grouped;
}

export async function listMemoAttachmentsForPage(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  memoIds: string[],
) {
  const attachments = await listAttachmentsForMemosForViewer(
    context.db,
    context.user,
    memoIds,
  );
  return groupByContentMemo(attachments, (attachment) => attachment.memoId);
}

export async function listMemoReactionsForPage(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  memoIds: string[],
) {
  const reactions = await listReactionsForMemosForViewer(
    context.db,
    context.user,
    memoIds,
  );
  return groupByContentMemo(reactions, (reaction) => reaction.contentId);
}

/**
 * Hydrate a page of already-scoped memo rows without re-fetching each memo:
 * attachments, reactions, relations and comment parents are each resolved with
 * a bounded number of batched queries per page instead of per row. Keeps the
 * exact DTO shape of the former per-memo detail fetch.
 */
export async function hydrateConnectMemos(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  memoRows: MemoRow[],
) {
  const ids = memoRows.map((memo) => memo.id);
  const [attachments, reactions, relationsByMemo, parents] = await Promise.all([
    listMemoAttachmentsForPage(context, ids),
    listMemoReactionsForPage(context, ids),
    listMemoRelationsForMemosForViewer(context.db, context.user, ids),
    getMemoParentsForViewer(context.db, context.user, ids),
  ]);
  const relationRows = [...relationsByMemo.values()].flat();
  const fetchRelationMemo = await relationMemoFetcher(context, relationRows, {
    includeDeleted: true,
  });
  return Promise.all(
    memoRows.map(async (memo) => {
      const relations = await memoRelationsToDtos(
        relationsByMemo.get(memo.id) ?? [],
        fetchRelationMemo,
      );
      return currentMemoToDto(memo, context.user, {
        attachments: attachments.get(memo.id) ?? [],
        reactions: reactions.get(memo.id) ?? [],
        relations,
        parent: parents.get(memo.id),
      });
    }),
  );
}

/**
 * Anonymous-capable variant for the public Memos read surface, mirroring
 * connectMemoWithDetails but resolving a page with batched attachment,
 * reaction, relation and endpoint reads, with creators cached across the page.
 */
export async function hydrateConnectPublicMemos(
  context: ConnectReadContext,
  memoRows: MemoRow[],
  parent?: string,
) {
  const ids = memoRows.map((memo) => memo.id);
  const [attachmentsByMemo, reactionsByMemo, relationsByMemo] =
    await Promise.all([
      listAttachmentsForMemosForViewer(context.db, context.user, ids),
      listReactionsForMemosForViewer(context.db, context.user, ids),
      listMemoRelationsForMemosForViewer(context.db, context.user, ids),
    ]);
  const attachments = groupByContentMemo(
    attachmentsByMemo,
    (attachment) => attachment.memoId,
  );
  const reactions = groupByContentMemo(
    reactionsByMemo,
    (reaction) => reaction.contentId,
  );
  const fetchRelationMemo = await relationMemoFetcher(
    context,
    [...relationsByMemo.values()].flat(),
  );
  const creators = new Map<string, UserRow>();
  return Promise.all(
    memoRows.map(async (memo) => {
      const relations = await memoRelationsToDtos(
        relationsByMemo.get(memo.id) ?? [],
        fetchRelationMemo,
        { skipUnavailable: true },
      );
      let creator = creators.get(memo.userId);
      if (!creator) {
        creator = await resolveMemoCreator(context, memo);
        creators.set(memo.userId, creator);
      }
      return currentMemoToDto(memo, creator, {
        attachments: attachments.get(memo.id) ?? [],
        reactions: reactions.get(memo.id) ?? [],
        relations,
        ...(parent ? { parent } : {}),
      });
    }),
  );
}

/**
 * State to the domain status. The upstream ListMemosRequest.state only
 * exposes NORMAL and ARCHIVED (STATE_UNSPECIFIED means "no filter"), so
 * trashed/deleted rows are reached through DeleteMemo and showDeleted, never
 * through the state field — matching the current REST surface.
 */
export function stateToLegacy(value: string | undefined) {
  const normalized = parseMemosState(value ?? "NORMAL");
  if (
    !normalized &&
    (value ?? "NORMAL").trim().toUpperCase() !== "STATE_UNSPECIFIED"
  ) {
    throw new CompatValidationError(`Unsupported memo state: ${value}`);
  }
  if (normalized && normalized !== "normal" && normalized !== "archived") {
    throw new CompatValidationError(`Unsupported memo state: ${value}`);
  }
  return normalized;
}
