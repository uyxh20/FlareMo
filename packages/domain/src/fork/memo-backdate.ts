import type { MemoRow } from "@flaremo/db";
import { ValidationError } from "../errors";

// Fork: editing a memo's created time (docs/fork-customizations.md, section 5).
// The rules live here so upstream's updateMemo only carries a few call-site
// lines. Covered by packages/domain/src/memo-backdate.test.ts.

export const FORK_ORIGINAL_CREATED_AT_KEY = "original_created_at";
const FORK_BACKDATE_FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * The created time a PATCH asks for, as the canonical ISO string the column
 * stores, or the existing value when nothing changes. Rejects a future time
 * (past the slack for clock skew) and an unreadable one.
 */
function forkResolveCreatedAt(
  requested: string | undefined,
  existing: MemoRow,
  now: string,
): string {
  if (requested === undefined) return existing.createdAt;
  const at = new Date(requested);
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError("created_at is not a valid time");
  }
  if (at.getTime() > Date.parse(now) + FORK_BACKDATE_FUTURE_SLACK_MS) {
    throw new ValidationError("created_at cannot be in the future");
  }
  // Same instant as before (the column may carry another ISO spelling).
  return Date.parse(existing.createdAt) === at.getTime()
    ? existing.createdAt
    : at.toISOString();
}

/**
 * Resolves the memo's next created time and keeps `original_created_at` in
 * `nextPayload` (mutated in place): the very first time is recorded on the first
 * move, and is carried over when a caller replaces the whole payload without it
 * (a revision restore, an `/api/v1` client), so later moves never record a
 * backdated time as the original. `changed` says whether the column moves, which
 * also means the payload must be written.
 */
export function forkApplyBackdate(
  existing: MemoRow,
  requested: string | undefined,
  nextPayload: Record<string, unknown>,
  now: string,
): { createdAt: string; changed: boolean } {
  const createdAt = forkResolveCreatedAt(requested, existing, now);
  const original = existing.payload[FORK_ORIGINAL_CREATED_AT_KEY];
  const changed = createdAt !== existing.createdAt;
  if (changed) {
    nextPayload[FORK_ORIGINAL_CREATED_AT_KEY] = original ?? existing.createdAt;
  } else if (
    original !== undefined &&
    nextPayload[FORK_ORIGINAL_CREATED_AT_KEY] === undefined
  ) {
    nextPayload[FORK_ORIGINAL_CREATED_AT_KEY] = original;
  }
  return { createdAt, changed };
}
