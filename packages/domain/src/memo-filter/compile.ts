import type { AttachmentRow, MemoRow, UserRow } from "@flaremo/db";
import type { ParseResult } from "@marcbachmann/cel-js";
import type { SQL } from "drizzle-orm";
import { ValidationError } from "../errors";
import { countAstNodes, isRecord, safeError } from "./ast-utils";
import { getMemoFilterEnvironment } from "./environment";
import { MAX_MEMO_FILTER_AST_NODES, MAX_MEMO_FILTER_LENGTH } from "./limits";
import {
  normalizeMemoFilterExpression,
  rejectReservedImplementationNames,
} from "./normalize";
import {
  memoFilterSqlIsComplete,
  memoFilterSqlPredicate,
} from "./sql-pushdown";
import {
  validateAttachmentFilterSurface,
  validateMemoFilterSurface,
} from "./validate";

/**
 * A compiled Memos CEL filter.  The parser/evaluator is deliberately kept in
 * the domain package so REST, Connect-shaped JSON, and MCP all evaluate the
 * same expression against the same resource context.
 */
export type CompiledMemoFilter = ((
  memo: MemoRow,
  user: UserRow | null,
) => boolean) & {
  sqlPredicate?: SQL;
  /**
   * True when the SQL predicate is an exact logical translation of the whole
   * CEL expression (for comparisons the evaluator and SQL agree on), so SQL
   * alone decides matches and the JS evaluator may be skipped entirely.
   */
  completeInSql: boolean;
};

export type CompiledAttachmentFilter = (attachment: AttachmentRow) => boolean;

/**
 * Compile a Memos CEL filter.
 *
 * Async because the CEL runtime is loaded on demand: a request without a
 * `filter=` expression resolves to `undefined` without ever pulling cel-js
 * into the isolate. The load is deliberately placed *after* the cheap
 * syntactic guards below so an absent, blank, oversized, or reserved-name
 * expression stays off the parser entirely.
 */
export async function compileMemoFilter(
  expression: string | undefined,
): Promise<CompiledMemoFilter | undefined> {
  const value = expression?.trim();
  if (!value) return undefined;
  if (value.length > MAX_MEMO_FILTER_LENGTH) {
    throw new ValidationError("Memos filter is too long");
  }
  rejectReservedImplementationNames(value);

  let compiled: ParseResult;
  try {
    compiled = (await getMemoFilterEnvironment()).parse(
      normalizeMemoFilterExpression(value),
    );
  } catch (error) {
    throw new ValidationError(`Invalid Memos CEL filter: ${safeError(error)}`);
  }

  if (countAstNodes(compiled.ast) > MAX_MEMO_FILTER_AST_NODES) {
    throw new ValidationError("Memos filter is too complex");
  }

  const checked = compiled.check();
  if (!checked.valid) {
    throw new ValidationError(
      `Invalid Memos CEL filter: ${safeError(checked.error)}`,
    );
  }
  if (checked.type !== "bool") {
    throw new ValidationError(
      "Invalid Memos CEL filter: filter must evaluate to a boolean",
    );
  }

  validateMemoFilterSurface(compiled.ast);

  const frozenNow = new Date();

  const evaluate: CompiledMemoFilter = (memo, user) => {
    const context = memoFilterContext(memo, user, frozenNow);
    try {
      return compiled(context) === true;
    } catch (error) {
      // A data-dependent failure (e.g. one malformed legacy payload) must not
      // turn the whole view into a permanent 400: the row is excluded from
      // this filter's results instead. Compile-time errors above still throw.
      if (isMemoFilterValidationError(error)) throw error;
      return false;
    }
  };
  evaluate.sqlPredicate = memoFilterSqlPredicate(compiled.ast);
  evaluate.completeInSql = memoFilterSqlIsComplete(compiled.ast);
  return evaluate;
}

/**
 * Compile the pinned upstream AttachmentService filter schema.
 *
 * Memos' Go server evaluates this schema with CEL before rendering it to SQL.
 * FlareMo has no SQL-rendering CEL compiler on Workers, so it evaluates the
 * same bounded expression against attachment metadata after applying the
 * owner/deleted/state boundary in the domain service. The route never gets a
 * second ad-hoc filter grammar.
 */
export async function compileAttachmentFilter(
  expression: string | undefined,
): Promise<CompiledAttachmentFilter | undefined> {
  const value = expression?.trim();
  if (!value) return undefined;
  if (value.length > MAX_MEMO_FILTER_LENGTH) {
    throw new ValidationError("Memos filter is too long");
  }
  rejectReservedImplementationNames(value);

  let compiled: ParseResult;
  try {
    compiled = (await getMemoFilterEnvironment()).parse(
      normalizeMemoFilterExpression(value),
    );
  } catch (error) {
    throw new ValidationError(`Invalid Memos CEL filter: ${safeError(error)}`);
  }

  if (countAstNodes(compiled.ast) > MAX_MEMO_FILTER_AST_NODES) {
    throw new ValidationError("Memos filter is too complex");
  }

  const checked = compiled.check();
  if (!checked.valid) {
    throw new ValidationError(
      `Invalid Memos CEL filter: ${safeError(checked.error)}`,
    );
  }
  if (checked.type !== "bool") {
    throw new ValidationError(
      "Invalid Memos CEL filter: filter must evaluate to a boolean",
    );
  }

  validateAttachmentFilterSurface(compiled.ast);
  const frozenNow = new Date();

  return (attachment) => {
    // Upstream exposes memo_id as CEL's nullable/dynamic value. Keep the
    // null case distinct from an empty resource name so `memo_id == null`
    // retains the same meaning for unbound attachments.
    const memoId = attachment.memoId ?? null;
    try {
      return (
        compiled({
          filename: attachment.filename,
          mime_type: attachment.contentType ?? "",
          create_time: new Date(attachment.createdAt),
          memo_id: memoId,
          memo: memoId,
          now: frozenNow,
        }) === true
      );
    } catch (error) {
      throw new ValidationError(
        `Memos CEL filter evaluation failed: ${safeError(error)}`,
      );
    }
  };
}

export function memoFilterContext(
  memo: MemoRow,
  user: UserRow | null,
  now = new Date(),
) {
  const payload = isRecord(memo.payload) ? memo.payload : {};
  const property = isRecord(payload.property)
    ? (payload.property as Record<string, unknown>)
    : {};
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    name: memo.id,
    content: memo.content,
    creator: user?.id ?? memo.userId,
    creator_id: memoCreatorId(user?.id ?? memo.userId),
    created_ts: new Date(memo.createdAt),
    updated_ts: new Date(memo.updatedAt),
    pinned: memo.pinned,
    visibility: memo.visibility.toUpperCase(),
    state: memo.status.toUpperCase(),
    tags,
    has_link: property.has_link === true || property.hasLink === true,
    has_task_list:
      property.has_task_list === true || property.hasTaskList === true,
    has_code: property.has_code === true || property.hasCode === true,
    has_incomplete_tasks:
      property.has_incomplete_tasks === true ||
      property.hasIncompleteTasks === true,
    // Memos freezes `now` during filter compilation. This matters when a
    // long-running page scans many rows near a time boundary.
    now,
  };
}

function memoCreatorId(userId: string) {
  if (userId === "users/owner") return 1n;
  const numericId = /^users\/([1-9][0-9]*)$/.exec(userId)?.[1];
  if (numericId) {
    const parsed = BigInt(numericId);
    if (parsed <= 2_147_483_647n) return parsed;
  }

  // 53-bit FNV space (two independent 32-bit rounds folded together): with
  // tens of thousands of users a 31-bit hash would collide at measurable
  // rates, and a collision would attribute a public memo to the wrong
  // author in creator_id filters.
  const bytes = new TextEncoder().encode(userId);
  const high = BigInt(fnv1a32(bytes, 0x811c9dc5));
  const low = BigInt(fnv1a32(bytes, 0x9dc5811c));
  const value = ((high << 32n) | low) & 0x1f_ffff_ffff_ffffn;
  return value > 1n ? value : 2n;
}

function fnv1a32(bytes: Uint8Array, seed: number) {
  let hash = seed;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

function isMemoFilterValidationError(error: unknown): boolean {
  return error instanceof ValidationError;
}
