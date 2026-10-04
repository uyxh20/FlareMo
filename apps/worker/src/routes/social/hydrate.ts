import type { MemoRow, memoRelations, ReactionRow, UserRow } from "@flaremo/db";
import {
  getMemosByIdsForViewer,
  listAttachmentsForMemosForViewer,
  listMemoAttachmentsForViewer,
  listMemoReactions,
  listMemoRelationsForMemosForViewer,
  listMemoRelationsForViewer,
  listReactionsForMemosForViewer,
} from "@flaremo/domain";
import {
  currentMemoToDto,
  currentReactionToDto,
  currentRelationToDto,
} from "@flaremo/memos";
import type { getOptionalRequestContext } from "../../context";
import { getFlaremoUserCached } from "../../identity-cache";
import { type MemoReactionPage, resolveMemoCreatorRow } from "./parsing";

type HydrationContext = Awaited<ReturnType<typeof getOptionalRequestContext>>;

/**
 * Turn relation rows into DTOs with two queries total: one batched memo read
 * for every endpoint across the whole page, then a local join. A relation
 * whose memo or target is not readable is dropped, which is what the previous
 * per-relation `getMemoByIdForViewer` + catch did.
 */
async function relationDtos(
  context: HydrationContext,
  relations: Array<typeof memoRelations.$inferSelect>,
) {
  if (relations.length === 0) return [];
  const memoIds = [
    ...new Set(relations.flatMap((row) => [row.memoId, row.relatedMemoId])),
  ];
  const relatedMemos = await getMemosByIdsForViewer(
    context.db,
    context.user,
    memoIds,
    { includeDeleted: true },
  );
  return relations.flatMap((relation) => {
    const memo = relatedMemos.get(relation.memoId);
    const relatedMemo = relatedMemos.get(relation.relatedMemoId);
    if (!memo || !relatedMemo) return [];
    return [currentRelationToDto(relation, memo, relatedMemo)];
  });
}

export async function memoToCurrentDto(
  context: Awaited<ReturnType<typeof getOptionalRequestContext>>,
  memo: MemoRow,
  parentName?: string,
) {
  const reactionPagePromise: Promise<MemoReactionPage> = listMemoReactions(
    context.db,
    context.user,
    {
      memoName: memo.id,
      pageSize: 1000,
    },
  );
  const [attachments, relationRows, reactionPage] = await Promise.all([
    listMemoAttachmentsForViewer(context.db, context.user, memo.id),
    listMemoRelationsForViewer(context.db, context.user, memo.id),
    reactionPagePromise,
  ]);
  const relations = await relationDtos(context, relationRows);
  const creator =
    context.user?.id === memo.userId
      ? context.user
      : await getFlaremoUserCached(context.db, memo.userId);
  if (!creator) throw new Error("Memo creator not found");
  return {
    ...currentMemoToDto(memo, creator, {
      attachments,
      relations,
    }),
    reactions: reactionPage.reactions.map((reaction) =>
      reactionToDto(reaction),
    ),
    ...(parentName ? { parent: parentName } : {}),
  };
}

export function reactionToDto(value: ReactionRow) {
  return currentReactionToDto(value);
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

/**
 * Hydrate a page of comment rows without the per-comment round trips:
 * attachments, reactions and relations are each resolved with one batched
 * query, and related memos with one more; creators are cached across the page.
 * Mirrors memoToCurrentDto's DTO shape exactly.
 */
export async function hydrateSocialMemos(
  context: Awaited<ReturnType<typeof getOptionalRequestContext>>,
  memoRows: MemoRow[],
  parentName?: string,
) {
  const ids = memoRows.map((memo) => memo.id);
  const [attachmentsByMemo, reactionRows, relationsByMemo] = await Promise.all([
    listAttachmentsForMemosForViewer(context.db, context.user, ids),
    listReactionsForMemosForViewer(context.db, context.user, ids),
    listMemoRelationsForMemosForViewer(context.db, context.user, ids),
  ]);
  const attachments = groupByContentMemo(
    attachmentsByMemo,
    (attachment) => attachment.memoId,
  );
  const reactions = groupByContentMemo(
    reactionRows,
    (reaction) => reaction.contentId,
  );
  const relationMemoIds = [
    ...new Set(
      [...relationsByMemo.values()]
        .flat()
        .flatMap((relation) => [relation.memoId, relation.relatedMemoId]),
    ),
  ];
  const relatedMemos = await getMemosByIdsForViewer(
    context.db,
    context.user,
    relationMemoIds,
    { includeDeleted: true },
  );
  const creators = new Map<string, UserRow | null>();
  return Promise.all(
    memoRows.map(async (memo) => {
      const relations = (relationsByMemo.get(memo.id) ?? []).flatMap(
        (relation) => {
          const relationMemo = relatedMemos.get(relation.memoId);
          const relatedMemo = relatedMemos.get(relation.relatedMemoId);
          if (!relationMemo || !relatedMemo) return [];
          return [currentRelationToDto(relation, relationMemo, relatedMemo)];
        },
      );
      const creator = await resolveMemoCreatorRow(context, creators, memo);
      return {
        ...currentMemoToDto(memo, creator, {
          attachments: attachments.get(memo.id) ?? [],
          relations,
        }),
        reactions: (reactions.get(memo.id) ?? []).map((reaction) =>
          reactionToDto(reaction),
        ),
        ...(parentName ? { parent: parentName } : {}),
      };
    }),
  );
}
