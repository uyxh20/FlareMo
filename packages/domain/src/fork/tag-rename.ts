import { normalizeTag } from "@flaremo/contracts";
import type { FlareMoDb, MemoPayload, MemoRow, UserRow } from "@flaremo/db";
import { memoRevisions, memos, memoTags } from "@flaremo/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { chunkForD1, d1IdsPerStatement } from "../d1-limits";
import { insertEmbeddingTask } from "../embedding-outbox";
import { ValidationError } from "../errors";
import {
  type HealthParseConfig,
  healthParseMemo,
  healthReadParseConfig,
} from "../health";
import { createResourceId } from "../ids";
import { insertMemosSseEvent } from "../memos-sse";
import { insertMemosWebhookEvent } from "../memos-webhooks";
import { rewriteTagInContent } from "../tags";

// A careful tag rename for the owner's own diary (fork-owned; used once to turn
// #gym into #fitness, docs/fork-customizations.md "Tag rename").
//
// Upstream's renameTag (packages/domain/src/tags.ts) does the same edit, and
// this reuses its token rewrite, so `#gymnastics`, `gym` inside a word, code
// spans and URLs are never touched. What this adds:
//
// - A dry run that changes nothing and lists every memo it would change: id,
//   length before and after, how many tags were rewritten. No diary text.
// - Checks before any write: each memo's new text, rewritten back, must be
//   exactly the old text, and the length must grow by exactly the tag
//   difference; and the health tracker must read the same rows from the new
//   text as from the old one. Any failure stops the run before it writes.
// - The memo's `updated_at` is kept, so the rename does not reorder the diary.
// - Memos whose text holds the tag but whose tag rows miss it (some imports
//   and the weekly review's own notes) are rewritten too. Their tag rows are
//   left as they are; only existing rows are renamed.
// - `memoIds` limits a run to those memos, which is how a run is undone
//   (rename back, on exactly the memos the first run changed).
//
// Like upstream it writes a revision of each memo's previous text (the undo
// record), queues a search re-index and emits the usual update events.

const MEMOS_PER_BATCH = 15;

export type ForkTagRenameInput = {
  from: string;
  to: string;
  dryRun: boolean;
  /** Only these memos (the undo of an earlier run). */
  memoIds?: readonly string[];
};

export type ForkTagRenameMemo = {
  id: string;
  created_at: string;
  status: string;
  before_length: number;
  after_length: number;
  /** `#from` tokens rewritten in the text. */
  replacements: number;
  /** The memo had a `from` row in memo_tags (renamed to `to`). */
  tag_row: boolean;
  /** The memo's payload listed `from` (renamed to `to`). */
  payload_tag: boolean;
  /** Health rows read from the old and the new text are the same. */
  health_same: boolean;
  /** The text round-trips and the length grows by exactly the tag change. */
  text_check: boolean;
};

export type ForkTagRenameResult = {
  from: string;
  to: string;
  dry_run: boolean;
  written: boolean;
  memos: ForkTagRenameMemo[];
  totals: {
    memos: number;
    replacements: number;
    tag_rows: number;
    payload_tags: number;
    health_changes: number;
    text_check_failures: number;
  };
};

/** Count of `#tag` tokens the rewrite would touch. */
function countTagTokens(content: string, tag: string): number {
  const marker = "\u0000";
  // Rewriting to a tag of one marker character keeps everything else equal,
  // so the length drop over the tag length is the token count.
  const swapped = rewriteTagInContent(content, tag, marker);
  return (content.length - swapped.length) / (tag.length - marker.length);
}

function renamePayloadTags(
  memo: MemoRow,
  from: string,
  to: string,
): { payload: MemoPayload; changed: boolean } {
  const payload: MemoPayload =
    memo.payload && typeof memo.payload === "object" ? { ...memo.payload } : {};
  if (!Array.isArray(payload.tags)) return { payload, changed: false };
  const tags = payload.tags.filter(
    (tag): tag is string => typeof tag === "string",
  );
  const moved = (tag: string) =>
    tag === from || tag.startsWith(`${from}/`)
      ? `${to}${tag.slice(from.length)}`
      : tag;
  const changed = tags.some((tag) => moved(tag) !== tag);
  if (!changed) return { payload, changed: false };
  return {
    payload: {
      ...payload,
      tags: tags
        .map(moved)
        .filter((tag, index, all) => all.indexOf(tag) === index)
        .sort((a, b) => a.localeCompare(b)),
    },
    changed: true,
  };
}

function payloadTagList(payload: MemoPayload | null | undefined): string[] {
  const tags =
    payload && typeof payload === "object" && Array.isArray(payload.tags)
      ? payload.tags
      : [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function healthReading(
  memo: { content: string; createdAt: string; source: string | null },
  tags: string[],
  config: HealthParseConfig,
): string {
  return JSON.stringify(
    healthParseMemo(
      {
        content: memo.content,
        createdAt: memo.createdAt,
        tags,
        source: memo.source,
      },
      config,
    ),
  );
}

export async function forkRenameTag(
  db: FlareMoDb,
  user: UserRow,
  input: ForkTagRenameInput,
): Promise<ForkTagRenameResult> {
  const from = normalizeTag(input.from);
  const to = normalizeTag(input.to);
  if (!from) throw new ValidationError("source tag is invalid");
  if (!to) throw new ValidationError("destination tag is invalid");
  if (from === to) throw new ValidationError("the tags are the same");
  if (from.length < 2 || to.length < 2) {
    throw new ValidationError("tags must be at least two characters");
  }
  if (from.includes("/") || to.includes("/")) {
    throw new ValidationError("only top-level tags can be renamed here");
  }

  // Candidates: tag rows, plus any of the owner's memos whose text holds the
  // token (LIKE is only a pre-filter; the rewrite decides).
  const rowIds = await db
    .select({ memoId: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, user.id),
        or(eq(memoTags.tag, from), sql`${memoTags.tag} LIKE ${`${from}/%`}`),
      ),
    )
    .all();
  const textIds = await db
    .select({ id: memos.id })
    .from(memos)
    .where(
      and(
        eq(memos.userId, user.id),
        sql`lower(${memos.content}) LIKE ${`%#${from}%`}`,
      ),
    )
    .all();
  const tagRowIds = new Set(rowIds.map((row) => row.memoId));
  let ids = [...new Set([...tagRowIds, ...textIds.map((row) => row.id)])];
  if (input.memoIds) {
    const only = new Set(input.memoIds);
    ids = ids.filter((id) => only.has(id));
  }

  const rows: MemoRow[] = [];
  for (const chunk of chunkForD1(ids, d1IdsPerStatement())) {
    rows.push(
      ...(await db
        .select()
        .from(memos)
        .where(and(inArray(memos.id, chunk), eq(memos.userId, user.id)))
        .all()),
    );
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const config = await healthReadParseConfig(db, user.id);
  const planned: Array<{
    memo: MemoRow;
    content: string;
    payload: MemoPayload;
    report: ForkTagRenameMemo;
  }> = [];

  for (const memo of rows) {
    const content = rewriteTagInContent(memo.content, from, to);
    const { payload, changed: payloadChanged } = renamePayloadTags(
      memo,
      from,
      to,
    );
    const hasRow = tagRowIds.has(memo.id);
    if (content === memo.content && !payloadChanged && !hasRow) continue;

    const replacements = countTagTokens(memo.content, from);
    const lengthOk =
      content.length - memo.content.length ===
      replacements * (to.length - from.length);
    // The way back must give the exact old text. When the memo already held
    // `#to` the way back would also touch those, so the length check stands
    // alone there.
    // The rewrite ignores case (`#Gym` becomes `#fitness`), so the way back is
    // compared with the old text's `#from` tokens in lower case.
    const roundTripOk =
      countTagTokens(memo.content, to) > 0 ||
      rewriteTagInContent(content, to, from) ===
        rewriteTagInContent(memo.content, from, from);
    const healthSame =
      healthReading(memo, payloadTagList(memo.payload), config) ===
      healthReading({ ...memo, content }, payloadTagList(payload), config);

    planned.push({
      memo,
      content,
      payload,
      report: {
        id: memo.id,
        created_at: memo.createdAt,
        status: memo.status,
        before_length: memo.content.length,
        after_length: content.length,
        replacements,
        tag_row: hasRow,
        payload_tag: payloadChanged,
        health_same: healthSame,
        text_check: lengthOk && roundTripOk,
      },
    });
  }

  const reports = planned.map((entry) => entry.report);
  const totals = {
    memos: reports.length,
    replacements: reports.reduce((sum, memo) => sum + memo.replacements, 0),
    tag_rows: reports.filter((memo) => memo.tag_row).length,
    payload_tags: reports.filter((memo) => memo.payload_tag).length,
    health_changes: reports.filter((memo) => !memo.health_same).length,
    text_check_failures: reports.filter((memo) => !memo.text_check).length,
  };
  const result: ForkTagRenameResult = {
    from,
    to,
    dry_run: input.dryRun,
    written: false,
    memos: reports,
    totals,
  };
  if (input.dryRun || planned.length === 0) return result;

  if (totals.text_check_failures > 0) {
    throw new ValidationError(
      `Stopped before writing: ${totals.text_check_failures} memo(s) failed the text check`,
    );
  }
  if (totals.health_changes > 0) {
    throw new ValidationError(
      `Stopped before writing: the health tracker would read ${totals.health_changes} memo(s) differently`,
    );
  }

  const now = new Date().toISOString();
  for (let offset = 0; offset < planned.length; offset += MEMOS_PER_BATCH) {
    const chunk = planned.slice(offset, offset + MEMOS_PER_BATCH);
    const chunkIds = chunk.map((entry) => entry.memo.id);
    const statements: unknown[] = [];
    // Tag rows: rename the existing ones, keeping their created_at. Delete
    // first so a memo that already carries `to` cannot collide.
    const chunkRows = await db
      .select()
      .from(memoTags)
      .where(
        and(
          eq(memoTags.userId, user.id),
          inArray(memoTags.memoId, chunkIds),
          or(eq(memoTags.tag, from), sql`${memoTags.tag} LIKE ${`${from}/%`}`),
        ),
      )
      .all();
    const existingTo = await db
      .select({ memoId: memoTags.memoId, tag: memoTags.tag })
      .from(memoTags)
      .where(
        and(
          eq(memoTags.userId, user.id),
          inArray(memoTags.memoId, chunkIds),
          or(eq(memoTags.tag, to), sql`${memoTags.tag} LIKE ${`${to}/%`}`),
        ),
      )
      .all();
    const taken = new Set(existingTo.map((row) => `${row.memoId}\n${row.tag}`));
    if (chunkRows.length > 0) {
      statements.push(
        db
          .delete(memoTags)
          .where(
            and(
              eq(memoTags.userId, user.id),
              inArray(memoTags.memoId, chunkIds),
              or(
                eq(memoTags.tag, from),
                sql`${memoTags.tag} LIKE ${`${from}/%`}`,
              ),
            ),
          ),
      );
    }
    for (const row of chunkRows) {
      const tag = `${to}${row.tag.slice(from.length)}`;
      const key = `${row.memoId}\n${tag}`;
      if (taken.has(key)) continue;
      taken.add(key);
      statements.push(
        db.insert(memoTags).values({
          memoId: row.memoId,
          userId: row.userId,
          tag,
          createdAt: row.createdAt,
        }),
      );
    }
    for (const { memo, content, payload } of chunk) {
      const revised: MemoRow = { ...memo, content, payload };
      statements.push(
        // updated_at is left as it was on purpose.
        db.update(memos).set({ content, payload }).where(eq(memos.id, memo.id)),
        db.insert(memoRevisions).values({
          id: createResourceId("revisions"),
          memoId: memo.id,
          userId: memo.userId,
          content: memo.content,
          visibility: memo.visibility,
          payload: memo.payload,
          createdAt: now,
        }),
        insertEmbeddingTask(db, {
          userId: memo.userId,
          resourceType: "memo",
          resourceId: memo.id,
          operation: "reindex",
          createdAt: now,
        }),
        insertMemosSseEvent(db, {
          type: "memo.updated",
          name: memo.id,
          visibility: revised.visibility,
          teamId: revised.teamId,
          creatorId: revised.userId,
          createdAt: now,
        }),
        insertMemosWebhookEvent(db, {
          receiverId: memo.userId,
          activityType: "memos.memo.updated",
          creator: user,
          memo: revised,
          createdAt: now,
        }),
      );
    }
    await db.batch(statements as unknown as Parameters<FlareMoDb["batch"]>[0]);
  }

  return { ...result, written: true };
}
