import type { MemoRow } from "@flaremo/db";
import { currentRelationToDto } from "@flaremo/memos";

export type RelationRow = Parameters<typeof currentRelationToDto>[0];

/**
 * Hydrate memo-relation rows into current Memos relation DTOs.
 *
 * The fetcher decides the read mode: the strict surfaces (Connect RPCs for
 * the authenticated owner) re-fetch both endpoints with
 * `getMemoById({ includeDeleted: true })` and let failures propagate, while
 * the public/viewer surfaces use `getMemoByIdForViewer` and drop relations
 * whose memos are no longer readable (`skipUnavailable`). Every Memos
 * compatibility surface previously carried its own copy of this loop.
 */
export async function memoRelationsToDtos(
  rows: readonly RelationRow[],
  fetchMemo: (memoId: string) => Promise<MemoRow>,
  options: { skipUnavailable?: boolean } = {},
) {
  const values = await Promise.all(
    rows.map(async (row) => {
      try {
        const [memo, relatedMemo] = await Promise.all([
          fetchMemo(row.memoId),
          fetchMemo(row.relatedMemoId),
        ]);
        return currentRelationToDto(row, memo, relatedMemo);
      } catch (error) {
        if (!options.skipUnavailable) throw error;
        return null;
      }
    }),
  );
  return values.filter(
    (value): value is NonNullable<typeof value> => value !== null,
  );
}
