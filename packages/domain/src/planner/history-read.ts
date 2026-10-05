import type { FlareMoDb } from "@flaremo/db";
import {
  type PlannerTaskEventRow,
  plannerTaskEvent,
} from "@flaremo/db/src/schema/planner";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { ValidationError } from "../errors";
import {
  plannerNormalizeTaskId,
  plannerRequireDay,
  plannerShiftDay,
} from "./shared";

// History reads: pure reads over the archive that history-sync.ts keeps
// (fork-owned add-on, docs/planning-cockpit-implementation-plan.md, section 4).
// They do not sync. The route layer runs `plannerSyncHistory` first and carries
// on whatever it returns, so a paused sync still serves what is archived.

/** An archived event as the routes return it. `source_ref` stays internal. */
export type PlannerEventDto = {
  id: number;
  task_id: string;
  /** The title when the event was archived; the task may be gone since. */
  task_title: string | null;
  /**
   * Upstream's `action` for activity events (`created`, `updated`,
   * `status_changed`, ...), else `deleted`, `restored`, `purged`, `created`
   * (sync) or a planner event (`planned`, `replanned`, `unplanned`,
   * `carried_over`, `dropped`, `undropped`).
   */
  type: string;
  data: Record<string, unknown>;
  source: "activity" | "sync" | "planner";
  actor_type: "user" | "agent" | null;
  actor_name: string | null;
  /** When it happened (the source timestamp), not when it was archived. */
  occurred_at: string;
  created_at: string;
};

export function plannerEventToDto(row: PlannerTaskEventRow): PlannerEventDto {
  return {
    id: row.id,
    task_id: row.taskId,
    task_title: row.taskTitle,
    type: row.type,
    data: row.data,
    source: row.source,
    actor_type: row.actorType,
    actor_name: row.actorName,
    occurred_at: row.occurredAt,
    created_at: row.createdAt,
  };
}

/** Rows a single task history read returns at most. */
export const plannerTaskHistoryLimit = 500;
/** Rows a range read returns when `limit` is omitted. */
export const plannerHistoryRangeLimit = 1000;
/** The most rows a range read returns, whatever `limit` asks for. */
export const plannerHistoryRangeMax = 5000;

function clampLimit(value: number | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * One task's archived events, newest first by `occurred_at`, then by archive id.
 * It reads the archive only, so the history of a purged task is still there. It
 * is scoped to `userId` and never checks that the task still exists.
 */
export async function plannerReadTaskHistory(
  db: FlareMoDb,
  input: { userId: string; taskId: string; limit?: number },
): Promise<PlannerEventDto[]> {
  const rows = await db
    .select()
    .from(plannerTaskEvent)
    .where(
      and(
        eq(plannerTaskEvent.userId, input.userId),
        eq(plannerTaskEvent.taskId, plannerNormalizeTaskId(input.taskId)),
      ),
    )
    .orderBy(desc(plannerTaskEvent.occurredAt), desc(plannerTaskEvent.id))
    .limit(clampLimit(input.limit, plannerTaskHistoryLimit, 2000));
  return rows.map(plannerEventToDto);
}

/**
 * The user's archived events across all tasks for the UTC days `from` to `to`
 * inclusive, newest first. `truncated` is true when more events matched than
 * were returned; the oldest are the ones cut.
 */
export async function plannerReadHistoryRange(
  db: FlareMoDb,
  input: { userId: string; from: string; to: string; limit?: number },
): Promise<{ events: PlannerEventDto[]; truncated: boolean }> {
  const from = plannerRequireDay(input.from, "from");
  const to = plannerRequireDay(input.to, "to");
  if (from > to) {
    throw new ValidationError("from must not be after to.");
  }
  const limit = clampLimit(
    input.limit,
    plannerHistoryRangeLimit,
    plannerHistoryRangeMax,
  );
  // Timestamps compare as ISO strings: a bare day sorts before every instant of
  // that day, so [from, day after to) covers the inclusive range.
  const rows = await db
    .select()
    .from(plannerTaskEvent)
    .where(
      and(
        eq(plannerTaskEvent.userId, input.userId),
        gte(plannerTaskEvent.occurredAt, from),
        lt(plannerTaskEvent.occurredAt, plannerShiftDay(to, 1)),
      ),
    )
    .orderBy(desc(plannerTaskEvent.occurredAt), desc(plannerTaskEvent.id))
    .limit(limit + 1);
  return {
    events: rows.slice(0, limit).map(plannerEventToDto),
    truncated: rows.length > limit,
  };
}
