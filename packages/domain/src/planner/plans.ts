import {
  type PlannerHorizon,
  plannerEffortMax,
  plannerHorizons,
  plannerIsValidDayKey,
  plannerPeriodStart,
  plannerTodoHorizon,
  type TaskDto,
  type TaskPriority,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  type PlannerTaskPlanRow,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import { and, eq } from "drizzle-orm";
import { ValidationError } from "../errors";
import { createTask, getTask, updateTask } from "../tasks";
import {
  type PlannerColumn,
  plannerColumnFor,
  plannerHasPlan,
  plannerIsColumn,
} from "./columns";
import {
  type PlannerActor,
  plannerEventStatement,
  plannerLoadLiveTask,
  plannerLoadPlan,
  plannerNormalizeTaskId,
  plannerNow,
  plannerRequireDay,
  plannerRunBatch,
} from "./shared";

// Plans, drops and column moves (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4).
//
// Every planner-table change is written in the SAME D1 batch as its planner
// event (M3). Task rows change only through upstream's services (M1): status
// and due date go through `updateTask`, so upstream logs its own activity and
// the next history sync archives it.
//
// These functions take a `UserRow`, not just an id, because upstream's
// `createTask` / `updateTask` / `getTask` do. A route passes the `user` and
// `actor` it already has, exactly as tasks-api.ts does.

/** Where a task is planned: any day inside the period, plus the period's size. */
export type PlannerPlanInput = { horizon: PlannerHorizon; day: string };

/** A plan row as the routes return it. */
export type PlannerPlanDto = {
  task_id: string;
  /** NULL means the backlog. `period_start` is NULL exactly when this is. */
  horizon: PlannerHorizon | null;
  period_start: string | null;
  /** How often rollover moved the plan forward because the task was unfinished. */
  carry_count: number;
  /** Set while the task is dropped, whatever its status. */
  dropped_at: string | null;
  /**
   * The effort estimate, 0 to 999 with at most one decimal; NULL when unset. A
   * row can exist only to hold it, with a NULL horizon.
   */
  effort: number | null;
  /** The start day, YYYY-MM-DD, or NULL. Held on the row like the effort (v1.2). */
  start_date: string | null;
  /** The stored board order `<column>|<key>`, or NULL (migration 9004). */
  board_rank: string | null;
  /** The weekly goal the task serves, or NULL (migration 9005). */
  goal_id: string | null;
  created_at: string;
  updated_at: string;
};

export function plannerPlanToDto(row: PlannerTaskPlanRow): PlannerPlanDto {
  return {
    task_id: row.taskId,
    horizon: row.horizon,
    period_start: row.periodStart,
    carry_count: row.carryCount,
    dropped_at: row.droppedAt,
    effort: row.effort ?? null,
    start_date: row.startDate ?? null,
    board_rank: row.boardRank ?? null,
    goal_id: row.goalId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** What a plan-changing function hands back for the route to serialise. */
export type PlannerTaskPlanResult = {
  task: TaskDto;
  plan: PlannerPlanDto | null;
};

type ResolvedPlan = { horizon: PlannerHorizon; periodStart: string };

/** The three statuses upstream's task enum has, which the four columns map onto. */
type StatusTarget = "todo" | "in_progress" | "done";

/** `{horizon, period_start}`, the shape the plan events store in `data`. */
type PlanPoint = {
  horizon: PlannerHorizon | null;
  period_start: string | null;
};

const DROPPED_MESSAGE = "The task is dropped. Undrop it first.";

/** Shown to the client when the plan could not be saved; details go to the log. */
const PLAN_ERROR_MESSAGE = "The plan could not be saved.";

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

// The loaders for a live task and its plan row live in shared.ts (the task
// comments read them too); the old local names stay as short aliases so the
// functions below read as they always did.
const loadLiveTask = plannerLoadLiveTask;
const loadPlan = plannerLoadPlan;

/**
 * Checks a requested plan and turns it into a period. The horizon and day are
 * validated before any period maths, which throws RangeError on bad input, and
 * a plan cannot start before the period that contains `today`.
 */
function resolvePlan(plan: PlannerPlanInput, today: string): ResolvedPlan {
  if (!(plannerHorizons as readonly unknown[]).includes(plan?.horizon)) {
    throw new ValidationError("horizon must be day, week or month.");
  }
  const day = plannerRequireDay(plan.day, "day");
  const periodStart = plannerPeriodStart(plan.horizon, day);
  if (periodStart < plannerPeriodStart(plan.horizon, today)) {
    throw new ValidationError("A plan cannot start before the current period.");
  }
  return { horizon: plan.horizon, periodStart };
}

/**
 * The plan a To Do task gets on the way in (v1.2): today, with the To Do horizon
 * from the contracts. Nothing shows the period and rollover never moves it, so
 * the only job it does is to keep the task out of the backlog.
 */
function todoMarker(today: string): ResolvedPlan {
  return {
    horizon: plannerTodoHorizon,
    periodStart: plannerPeriodStart(plannerTodoHorizon, today),
  };
}

function pointOf(plan: PlannerTaskPlanRow | undefined): PlanPoint {
  return plannerHasPlan(plan) && plan
    ? { horizon: plan.horizon, period_start: plan.periodStart }
    : { horizon: null, period_start: null };
}

function assertNotDropped(plan: PlannerTaskPlanRow | undefined): void {
  if (plan?.droppedAt) throw new ValidationError(DROPPED_MESSAGE);
}

type PlanEventType = "planned" | "replanned" | "unplanned";

/** The event a plan change produces, or null when nothing would change. */
function transitionOf(
  existing: PlannerTaskPlanRow | undefined,
  next: ResolvedPlan | null,
): PlanEventType | null {
  const had = plannerHasPlan(existing);
  if (next === null) return had ? "unplanned" : null;
  if (!had) return "planned";
  return existing?.horizon === next.horizon &&
    existing.periodStart === next.periodStart
    ? null
    : "replanned";
}

/**
 * Sets, moves or clears a task's plan and writes the matching event in the same
 * batch. Returns the event type, or null when the plan already was that way.
 * `carry_count` is never touched here: only rollover moves it.
 */
async function writePlanChange(
  db: FlareMoDb,
  input: {
    userId: string;
    actor: PlannerActor;
    task: { id: string; title: string };
    existing: PlannerTaskPlanRow | undefined;
    next: ResolvedPlan | null;
    now: Date;
  },
): Promise<PlanEventType | null> {
  const type = transitionOf(input.existing, input.next);
  if (type === null) return null;
  const nowIso = input.now.toISOString();
  const horizon = input.next?.horizon ?? null;
  const periodStart = input.next?.periodStart ?? null;
  await plannerRunBatch(db, [
    db
      .insert(plannerTaskPlan)
      .values({
        taskId: input.task.id,
        userId: input.userId,
        horizon,
        periodStart,
        carryCount: 0,
        droppedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: plannerTaskPlan.taskId,
        set: { horizon, periodStart, updatedAt: nowIso },
      }),
    plannerEventStatement(db, {
      userId: input.userId,
      taskId: input.task.id,
      taskTitle: input.task.title,
      type,
      data: {
        from: pointOf(input.existing),
        to: { horizon, period_start: periodStart } satisfies PlanPoint,
      },
      actor: input.actor,
      occurredAt: nowIso,
    }),
  ]);
  return type;
}

async function resultFor(
  db: FlareMoDb,
  user: UserRow,
  taskId: string,
): Promise<PlannerTaskPlanResult> {
  const [task, plan] = await Promise.all([
    getTask(db, user, taskId),
    loadPlan(db, user.id, taskId),
  ]);
  return { task, plan: plan ? plannerPlanToDto(plan) : null };
}

/**
 * A live task and its plan, read back without changing anything. Upstream's
 * `updateTask` returns only the task, so a route that has just edited task
 * fields (and no plan) calls this to answer with the plan as well. A task that
 * is missing, deleted or someone else's is a 404, like upstream's `getTask`.
 */
export async function plannerReadTaskPlan(
  db: FlareMoDb,
  input: { user: UserRow; taskId: string },
): Promise<PlannerTaskPlanResult> {
  return resultFor(db, input.user, plannerNormalizeTaskId(input.taskId));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** The upstream status a task created in each column starts with. */
const CREATE_STATUS: Record<PlannerColumn, StatusTarget> = {
  backlog: "todo",
  todo: "todo",
  doing: "in_progress",
  done: "done",
};

/**
 * Creates a task through upstream's `createTask` and, when a plan is given,
 * writes the plan and its `planned` event in one batch.
 *
 * `column` says where the task should land, the way a column's "+" button does:
 *
 *   backlog   status `todo`, no plan (a plan is a 400)
 *   todo      status `todo`, and a plan is required (a 400 without one)
 *   doing     status `in_progress`; the plan is optional
 *   done      status `done`, completed now; the plan is optional
 *
 * Without `column` the task is `todo`, planned when a plan is given, as before.
 * The status goes in upstream's own `createTask` input, so a task made in Doing
 * or Done is one write with one `created` activity, never a `todo` task that
 * could be left behind if a second write failed.
 *
 * A bad column or plan is rejected BEFORE the task exists. If the plan batch
 * itself then fails, the task is still created and the result carries
 * `plan: null` and a `planError`, so the client can offer "Retry plan" (a To Do
 * task without its plan reads as Backlog; Doing and Done stay where they are).
 * `today` is required whenever `plan` is given.
 *
 * The `planned` event is stamped AFTER `createTask` returns, unless the caller
 * passes `now`. Upstream stamps its own `created` activity while it runs, so a
 * clock read before the call put `planned` a few milliseconds earlier than
 * `created` and the history listed the plan before the task existed.
 */
export async function plannerCreateTask(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    title: string;
    notes?: string;
    priority?: TaskPriority;
    dueAt?: string;
    projectId?: string;
    column?: PlannerColumn;
    plan?: PlannerPlanInput | null;
    today?: string;
    now?: Date;
  },
): Promise<{ task: TaskDto; plan: PlannerPlanDto | null; planError?: string }> {
  const column = input.column;
  if (column !== undefined) {
    if (!plannerIsColumn(column)) {
      throw new ValidationError("column must be backlog, todo, doing or done.");
    }
    if (column === "backlog" && input.plan) {
      throw new ValidationError(
        "A task created in Backlog cannot have a plan.",
      );
    }
    if (column === "todo" && !input.plan) {
      throw new ValidationError("A task created in To Do needs a plan.");
    }
  }
  let resolved: ResolvedPlan | null = null;
  if (input.plan) {
    if (input.today === undefined) {
      throw new ValidationError("today is required with a plan.");
    }
    resolved = resolvePlan(input.plan, plannerRequireDay(input.today, "today"));
  }

  const task = await createTask(db, input.user, input.actor, {
    title: input.title,
    notes: input.notes,
    priority: input.priority,
    due_at: input.dueAt,
    project_id: input.projectId,
    status: column === undefined ? "todo" : CREATE_STATUS[column],
  });
  if (!resolved) return { task, plan: null };

  // Read the clock only now: `createTask` has finished, so its `created`
  // activity is already stamped and this event can never sort before it.
  const now = plannerNow(input.now);
  try {
    await writePlanChange(db, {
      userId: input.user.id,
      actor: input.actor,
      task: { id: task.id, title: task.title },
      existing: undefined,
      next: resolved,
      now,
    });
    const plan = await loadPlan(db, input.user.id, task.id);
    return { task, plan: plan ? plannerPlanToDto(plan) : null };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Planner plan write failed after the task was created",
        task: task.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { task, plan: null, planError: PLAN_ERROR_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// Plan, replan, unplan
// ---------------------------------------------------------------------------

/**
 * Plans a task (`plan` given) or sends it back to the backlog (`plan: null`),
 * writing a `planned`, `replanned` or `unplanned` event with `{from, to}`. A
 * request that changes nothing writes nothing. A dropped task must be undropped
 * first.
 */
export async function plannerSetPlan(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    plan: PlannerPlanInput | null;
    today: string;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult> {
  const today = plannerRequireDay(input.today, "today");
  const next = input.plan === null ? null : resolvePlan(input.plan, today);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  assertNotDropped(existing);

  await writePlanChange(db, {
    userId: input.user.id,
    actor: input.actor,
    task,
    existing,
    next,
    now: plannerNow(input.now),
  });
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/**
 * A valid effort, or a 400: a finite number from 0 to `plannerEffortMax` (999,
 * shared with the request schema in @flaremo/contracts) with at most one
 * decimal place, or null to clear it. The result is the clean value to store
 * (1.1 stays 1.1, not 1.1000000000000001; -0 becomes 0).
 */
export function plannerNormalizeEffort(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError("effort must be a number, or null to clear it.");
  }
  if (value < 0 || value > plannerEffortMax) {
    throw new ValidationError(`effort must be from 0 to ${plannerEffortMax}.`);
  }
  const tenths = Math.round(value * 10);
  // Binary floats: 1.1 * 10 is 11.000000000000002, so compare with a tolerance.
  if (Math.abs(value * 10 - tenths) > 1e-9) {
    throw new ValidationError("effort can have at most one decimal place.");
  }
  return tenths === 0 ? 0 : tenths / 10;
}

/**
 * Sets or clears a task's effort estimate and writes an `effort_changed` event
 * `{from, to}` in the same batch. The estimate lives on the plan row, so a task
 * that has none gets a row with a NULL horizon, which plans nothing (the board
 * reads a NULL horizon as the backlog). A request that changes nothing writes
 * nothing. Unlike a plan change it is allowed on a dropped task: the estimate
 * does not move the task anywhere.
 */
export async function plannerSetEffort(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    effort: number | null;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult> {
  const effort = plannerNormalizeEffort(input.effort);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  const from = existing?.effort ?? null;

  if (from !== effort) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .insert(plannerTaskPlan)
        .values({
          taskId,
          userId: input.user.id,
          horizon: null,
          periodStart: null,
          carryCount: 0,
          droppedAt: null,
          effort,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: plannerTaskPlan.taskId,
          set: { effort, updatedAt: nowIso },
        }),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "effort_changed",
        data: { from, to: effort },
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Start date
// ---------------------------------------------------------------------------

/**
 * A valid start day, `YYYY-MM-DD`, or null to clear it; anything else is a 400.
 * The day is returned as it was given, since it has already been checked to be
 * a real calendar day.
 */
export function plannerNormalizeStartDate(value: unknown): string | null {
  if (value === null) return null;
  if (!plannerIsValidDayKey(value)) {
    throw new ValidationError(
      "start_date must be a real YYYY-MM-DD day, or null to clear it.",
    );
  }
  return value;
}

/**
 * Sets or clears a task's start date and writes a `start_date_changed` event
 * `{from, to}` in the same batch. Like the effort, the date lives on the plan row,
 * so a task that has none gets a row with a NULL horizon, which plans nothing. A
 * request that changes nothing writes nothing. It never moves the task, so it is
 * allowed on a dropped task too.
 */
export async function plannerSetStartDate(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    startDate: string | null;
    now?: Date;
  },
): Promise<PlannerTaskPlanResult> {
  const startDate = plannerNormalizeStartDate(input.startDate);
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  const from = existing?.startDate ?? null;

  if (from !== startDate) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .insert(plannerTaskPlan)
        .values({
          taskId,
          userId: input.user.id,
          horizon: null,
          periodStart: null,
          carryCount: 0,
          droppedAt: null,
          startDate,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: plannerTaskPlan.taskId,
          set: { startDate, updatedAt: nowIso },
        }),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "start_date_changed",
        data: { from, to: startDate },
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Drop and undrop
// ---------------------------------------------------------------------------

/**
 * Drops a task: `dropped_at` is set, the plan is kept, and the `dropped` event
 * stores `previous_due_at`, the only reliable record of the due date this
 * clears. The due date is then cleared through upstream's `updateTask` so a
 * dropped task stops sending overdue alerts (decision D1).
 *
 * The planner write comes first. If clearing the due date fails, the task is
 * dropped but still dated; dropping it again clears the date without writing a
 * second event. A task that is already dropped is not dropped twice.
 */
export async function plannerDropTask(
  db: FlareMoDb,
  input: { user: UserRow; actor: PlannerActor; taskId: string; now?: Date },
): Promise<PlannerTaskPlanResult> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);

  if (!existing?.droppedAt) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .insert(plannerTaskPlan)
        .values({
          taskId,
          userId: input.user.id,
          horizon: null,
          periodStart: null,
          carryCount: 0,
          droppedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: plannerTaskPlan.taskId,
          set: { droppedAt: nowIso, updatedAt: nowIso },
        }),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "dropped",
        data: { previous_due_at: task.dueAt },
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }

  if (task.dueAt !== null) {
    await updateTask(db, input.user, input.actor, taskId, { due_at: null });
  }
  return resultFor(db, input.user, taskId);
}

/**
 * Undrops a task: `dropped_at` is cleared and an `undropped` event written. The
 * kept plan decides where the task lands again, and the old due date is NOT
 * restored. A task that is not dropped is left alone.
 */
export async function plannerUndropTask(
  db: FlareMoDb,
  input: { user: UserRow; actor: PlannerActor; taskId: string; now?: Date },
): Promise<PlannerTaskPlanResult> {
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);

  if (existing?.droppedAt) {
    const nowIso = plannerNow(input.now).toISOString();
    await plannerRunBatch(db, [
      db
        .update(plannerTaskPlan)
        .set({ droppedAt: null, updatedAt: nowIso })
        .where(
          and(
            eq(plannerTaskPlan.taskId, taskId),
            eq(plannerTaskPlan.userId, input.user.id),
          ),
        ),
      plannerEventStatement(db, {
        userId: input.user.id,
        taskId,
        taskTitle: task.title,
        type: "undropped",
        data: {},
        actor: input.actor,
        occurredAt: nowIso,
      }),
    ]);
  }
  return resultFor(db, input.user, taskId);
}

// ---------------------------------------------------------------------------
// Column moves
// ---------------------------------------------------------------------------

/** Plan before today's period: the one case where "Done to To Do" re-plans. */
function isPast(plan: PlannerTaskPlanRow, today: string): boolean {
  return (
    plan.horizon !== null &&
    plan.periodStart !== null &&
    plan.periodStart < plannerPeriodStart(plan.horizon, today)
  );
}

/**
 * Moves a card to a column, applying the plan's column-move table:
 *
 *   Backlog to To Do        plan = this week (default)
 *   To Do to Backlog        plan cleared
 *   Backlog or To Do to Doing   status in_progress, plan kept
 *   any to Done             status done, plan kept for history
 *   Doing to To Do          status todo; no plan (or NULL horizon): plan = this week
 *   Doing or Done to Backlog    status todo, plan cleared
 *   Done to To Do           status todo; plan missing, NULL horizon or past: this week
 *   Done to Doing           status in_progress
 *
 * A move to the column the task is already in does nothing. A task with an
 * unknown status moves like any other. A dropped task cannot be moved.
 *
 * Order: the plan batch runs first, then the status write through upstream's
 * `updateTask`. For a card leaving Doing or Done the plan does not decide its
 * column, so a failure between the two never shows a wrong column.
 */
export async function plannerApplyColumnMove(
  db: FlareMoDb,
  input: {
    user: UserRow;
    actor: PlannerActor;
    taskId: string;
    to: PlannerColumn;
    today: string;
    now?: Date;
  },
): Promise<
  PlannerTaskPlanResult & { from: PlannerColumn | "other"; to: PlannerColumn }
> {
  if (!plannerIsColumn(input.to)) {
    throw new ValidationError("to must be backlog, todo, doing or done.");
  }
  const to = input.to;
  const today = plannerRequireDay(input.today, "today");
  const taskId = plannerNormalizeTaskId(input.taskId);
  const task = await loadLiveTask(db, input.user.id, taskId);
  const existing = await loadPlan(db, input.user.id, taskId);
  assertNotDropped(existing);

  const from = plannerColumnFor({
    status: task.status,
    horizon: existing?.horizon ?? null,
    periodStart: existing?.periodStart ?? null,
    droppedAt: null,
  }) as PlannerColumn | "other";
  if (from === to) {
    return { ...(await resultFor(db, input.user, taskId)), from, to };
  }

  const hasPlan = plannerHasPlan(existing);
  let status: StatusTarget | null = null;
  let plan: ResolvedPlan | null | undefined; // undefined: leave the plan alone

  switch (to) {
    case "todo":
      status = "todo";
      if (from === "backlog" || !hasPlan) plan = todoMarker(today);
      else if (from === "done" && existing && isPast(existing, today)) {
        plan = todoMarker(today);
      }
      break;
    case "backlog":
      status = "todo";
      if (hasPlan) plan = null;
      break;
    case "doing":
      status = "in_progress";
      break;
    case "done":
      status = "done";
      break;
  }

  if (plan !== undefined) {
    await writePlanChange(db, {
      userId: input.user.id,
      actor: input.actor,
      task,
      existing,
      next: plan,
      now: plannerNow(input.now),
    });
  }
  if (status !== null && status !== task.status) {
    await updateTask(db, input.user, input.actor, taskId, { status });
  }
  return { ...(await resultFor(db, input.user, taskId)), from, to };
}
