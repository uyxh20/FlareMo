import { plannerIsValidDayKey } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { plannerTaskEvent } from "@flaremo/db/src/schema/planner";
import { ValidationError } from "../errors";
import { parseResourceName } from "../ids";
import type { TaskActor } from "../tasks";

// Helpers shared by the planning cockpit's domain modules (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md). Nothing here is part of the
// public surface the routes use, but every export keeps the planner prefix (M8).

/**
 * The actor behind a planner mutation. It is upstream's `TaskActor` on purpose:
 * routes derive it exactly like `tasks-api.ts` does (a cookie session is the
 * owner, a PAT is an agent), and planner events store it the way upstream's
 * `task_activity` rows do.
 */
export type PlannerActor = TaskActor;

/** Whether the history archive is being kept up to date. */
export type PlannerHistoryStatus = "ok" | "paused";

/** The slice of a D1 result the planner reads: how many rows a statement changed. */
export type PlannerBatchResult = { meta?: { changes?: number } };

type PlannerBatchItems = Parameters<FlareMoDb["batch"]>[0];

/**
 * Runs Drizzle statement builders as ONE D1 batch (a single transaction).
 *
 * Only builders belong here: `db.insert/update/delete(...)`, with `sql` inside
 * `.select()`, `.values()`, `.set()` and `.where()`. A bare `db.run(sql...)`
 * with bound parameters throws inside `db.batch` (Drizzle's raw wrapper has no
 * prepared statement), so it is not an option.
 */
export async function plannerRunBatch(
  db: FlareMoDb,
  statements: readonly unknown[],
): Promise<PlannerBatchResult[]> {
  if (statements.length === 0) return [];
  const results = await db.batch(statements as unknown as PlannerBatchItems);
  return results as unknown as PlannerBatchResult[];
}

/** Rows a batch statement changed; 0 for a skipped `ON CONFLICT DO NOTHING`. */
export function plannerChanges(result: PlannerBatchResult | undefined): number {
  return result?.meta?.changes ?? 0;
}

/** The actor columns of a planner event, mirroring upstream's activity rows. */
export function plannerActorColumns(actor: PlannerActor): {
  actorType: "user" | "agent";
  actorName: string | null;
} {
  return {
    actorType: actor.type,
    actorName: actor.type === "agent" ? (actor.name ?? null) : null,
  };
}

/** A `YYYY-MM-DD` day, or a 400. Period maths throws RangeError, so validate first. */
export function plannerRequireDay(value: unknown, label: string): string {
  if (!plannerIsValidDayKey(value)) {
    throw new ValidationError(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

/** Accepts a bare task id or `tasks/<id>`, like the upstream task routes. */
export function plannerNormalizeTaskId(value: string): string {
  return parseResourceName(value.trim(), "tasks");
}

/** Accepts a bare project id or `projects/<id>`, like the upstream project routes. */
export function plannerNormalizeProjectId(value: string): string {
  return parseResourceName(value.trim(), "projects");
}

/** The request time, defaulting to the real clock; tests pass their own. */
export function plannerNow(now?: Date): Date {
  return now ?? new Date();
}

/**
 * A short, single-line description of a failure. It goes into
 * `planner_sync_state.paused_reason` and logs, so it is bounded.
 */
export function plannerDescribeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Moves a `YYYY-MM-DD` day by whole days using UTC maths only. */
export function plannerShiftDay(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * One planner-sourced event row, for a statement that runs in the same batch as
 * the planner-table change it describes (M3). `created_at` equals `occurred_at`
 * because a planner event is archived the moment it happens.
 */
export function plannerEventStatement(
  db: FlareMoDb,
  event: {
    userId: string;
    taskId: string;
    taskTitle: string | null;
    type: "planned" | "replanned" | "unplanned" | "dropped" | "undropped";
    data: Record<string, unknown>;
    actor: PlannerActor;
    occurredAt: string;
  },
) {
  return db.insert(plannerTaskEvent).values({
    userId: event.userId,
    taskId: event.taskId,
    taskTitle: event.taskTitle,
    type: event.type,
    data: event.data,
    source: "planner",
    sourceRef: null,
    ...plannerActorColumns(event.actor),
    occurredAt: event.occurredAt,
    createdAt: event.occurredAt,
  });
}
